import fetch from 'node-fetch'
import * as cheerio from 'cheerio'
import fs from 'fs/promises'
import Parser from 'rss-parser'

const ngProfileURL = 'https://goobieng.newgrounds.com/'
const youtubeRssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC-xSJRpIEmeNXj-em-psGtA'
const saveDir = '/srv/site-scraper/latest-posts'
let parser = new Parser()
const REQUEST_TIMEOUT_MS = 10000
const MAX_ART_RESULTS_TO_SCAN = 24
const FURAFFINITY_USERNAME = 'GracieArt'
const FURAFFINITY_A_TOKEN = 'af77c04b-e1d5-4ac0-ad62-159d20bc5d85'
const FURAFFINITY_B_TOKEN = '9ae6c256-53ae-41fb-be56-c89301f495a3'

function buildFACookieHeader() {
    return `a=${FURAFFINITY_A_TOKEN}; b=${FURAFFINITY_B_TOKEN}`
}

function withTimeout(promise, timeoutMs, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        })
    ])
}

function normalizeExternalUrl(url) {
    if (!url) return ''
    if (url.includes('undefined')) return ''
    if (url.startsWith('//')) return `https:${url}`
    if (url.startsWith('http:')) return url.replace('http:', 'https:')
    return url
}

function isValidImageUrl(url) {
    return Boolean(url && (url.startsWith('https://') || url.startsWith('http://')) && !url.includes('undefined'))
}

function ratingFromFigureClass(className = '') {
    if (className.includes('r-general')) return 1
    if (className.includes('r-mature')) return 2
    if (className.includes('r-adult')) return 4
    return 0
}

function parseGalleryResults(html) {
    const $ = cheerio.load(html)
    const results = []

    $('figure').each((_, figure) => {
        const node = $(figure)
        const className = node.attr('class') || ''
        const idRaw = node.attr('id') || ''
        const id = (idRaw.match(/(\d+)/) || [])[1] || ''

        const titleAnchor = node.find('figcaption p').first().find('a').first()
        const title = (titleAnchor.text() || '').trim()
        const href = titleAnchor.attr('href') || ''
        const url = normalizeExternalUrl(href.startsWith('/') ? `https://www.furaffinity.net${href}` : href)

        const thumbSrc =
            node.find('img').first().attr('src') ||
            node.find('img').first().attr('data-src') ||
            ''

        const rating = ratingFromFigureClass(className)

        if (!title || !url) {
            return
        }

        results.push({
            id,
            title,
            url,
            rating,
            thumb: {
                medium: normalizeExternalUrl(thumbSrc),
                small: normalizeExternalUrl(thumbSrc),
                tiny: normalizeExternalUrl(thumbSrc),
                icon: normalizeExternalUrl(thumbSrc),
                large: normalizeExternalUrl(thumbSrc)
            }
        })
    })

    return results
}

async function fetchFAGalleryPage(username, page = 1) {
    const url = `https://www.furaffinity.net/gallery/${username}/${page}/`
    const res = await withTimeout(
        fetch(url, {
            headers: {
                cookie: buildFACookieHeader(),
                'user-agent': 'site-scraper/1.0 (+https://goobie.xyz)',
                accept: 'text/html,application/xhtml+xml'
            }
        }),
        REQUEST_TIMEOUT_MS,
        `FA gallery fetch ${username}/${page}`
    )

    if (!res.ok) {
        throw new Error(`FA gallery request failed: ${res.status}`)
    }

    return res.text()
}

function getThumbCandidatesFromResult(result) {
    return [
        normalizeExternalUrl(result?.thumb?.medium || ''),
        normalizeExternalUrl(result?.thumb?.small || ''),
        normalizeExternalUrl(result?.thumb?.tiny || ''),
        normalizeExternalUrl(result?.thumb?.icon || ''),
        normalizeExternalUrl(result?.thumb?.large || '')
    ].filter((value, index, arr) => isValidImageUrl(value) && arr.indexOf(value) === index)
}

async function scrapeImageFromSubmissionPage(submissionUrl) {
    if (!submissionUrl) return ''

    const res = await withTimeout(
        fetch(submissionUrl, {
            headers: {
                'user-agent': 'site-scraper/1.0 (+https://goobie.xyz)'
            }
        }),
        5000,
        `Submission page fetch ${submissionUrl}`
    )

    if (!res.ok) return ''

    const html = await res.text()
    const $ = cheerio.load(html)

    const ogImage = $('meta[property="og:image"]').attr('content') || ''
    const twitterImage = $('meta[name="twitter:image"]').attr('content') || ''
    const picked = normalizeExternalUrl(ogImage || twitterImage)

    return isValidImageUrl(picked) ? picked : ''
}

function logStep(step, details = '') {
    const suffix = details ? ` ${details}` : ''
    console.log(`[site-scraper] ${new Date().toISOString()} ${step}${suffix}`)
}

async function pickWorkingImageUrl(urls) {
    for (const url of urls) {
        if (!url) continue

        try {
            const headRes = await withTimeout(
                fetch(url, {
                    method: 'HEAD',
                    headers: {
                        'user-agent': 'site-scraper/1.0 (+https://goobie.xyz)'
                    }
                }),
                4000,
                `HEAD ${url}`
            )

            const headType = (headRes.headers.get('content-type') || '').toLowerCase()
            if (headRes.ok && headType.includes('image')) {
                return { url, via: 'HEAD', status: headRes.status }
            }

            const getRes = await withTimeout(
                fetch(url, {
                    method: 'GET',
                    headers: {
                        'user-agent': 'site-scraper/1.0 (+https://goobie.xyz)',
                        range: 'bytes=0-0'
                    }
                }),
                4000,
                `GET ${url}`
            )

            const getType = (getRes.headers.get('content-type') || '').toLowerCase()
            if (getRes.ok && getType.includes('image')) {
                return { url, via: 'GET', status: getRes.status }
            }
        } catch (err) {
            logStep('saveArtPost:thumb-probe-error', `${url} :: ${err?.message || err}`)
        }
    }

    return null
}


// --- MAIN SHIZZZZ ---

// save da post
async function savePostData(postData, filename) {
    let jsonData = JSON.stringify(postData, null, 2)
   
    try {
        await fs.writeFile(saveDir+"/"+filename, jsonData)
    } catch (err) {
        console.error('Error occurred while reading directory:', err)
    }
}

async function saveArtPost() {
    const startedAt = Date.now()
    logStep('saveArtPost:start')

    let results
    try {
        const html = await fetchFAGalleryPage(FURAFFINITY_USERNAME, 1)
        results = parseGalleryResults(html)
        logStep('saveArtPost:gallery-ok', `count=${results.length}`)
    } catch (err) {
        console.error('Error fetching FurAffinity gallery:', err)
        throw err
    }

    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('No gallery results found for GracieArt')
    }

    // Use gallery metadata directly: getSubmission() is the common hang/failure point.
    const candidates = results.slice(0, MAX_ART_RESULTS_TO_SCAN)
    const generalCandidates = candidates.filter((r) => typeof r?.rating === 'number' && r.rating === 1)

    let chosen = null
    let thumbCandidates = []

    for (const result of generalCandidates) {
        const thumbs = getThumbCandidatesFromResult(result)
        if (thumbs.length > 0) {
            chosen = result
            thumbCandidates = thumbs
            break
        }
    }

    if (!chosen) {
        for (const result of candidates) {
            const thumbs = getThumbCandidatesFromResult(result)
            if (thumbs.length > 0) {
                chosen = result
                thumbCandidates = thumbs
                break
            }
        }
    }

    if (!chosen) {
        chosen = generalCandidates[0] || candidates[0]
    }

    if (!chosen) {
        throw new Error('No art candidate found in gallery results')
    }

    if (thumbCandidates.length === 0) {
        thumbCandidates = getThumbCandidatesFromResult(chosen)
    }

    logStep('saveArtPost:candidate-selected', `id=${chosen.id} thumbs=${thumbCandidates.length}`)

    if (thumbCandidates.length === 0) {
        try {
            const submissionUrl = normalizeExternalUrl(chosen.url || (chosen.id ? ('https://www.furaffinity.net/view/' + chosen.id + '/') : ''))
            logStep('saveArtPost:html-fallback:start', submissionUrl)
            const htmlFallbackImage = await scrapeImageFromSubmissionPage(submissionUrl)
            if (isValidImageUrl(htmlFallbackImage)) {
                thumbCandidates.push(htmlFallbackImage)
                logStep('saveArtPost:html-fallback:done', htmlFallbackImage)
            } else {
                logStep('saveArtPost:html-fallback:done', 'no image found')
            }
        } catch (err) {
            logStep('saveArtPost:html-fallback:error', err?.message || String(err))
        }
    }

    const chosenThumb = await pickWorkingImageUrl(thumbCandidates)
    const imgSrc = chosenThumb?.url || thumbCandidates[0] || ''
    if (chosenThumb) {
        logStep('saveArtPost:thumb-selected', `${chosenThumb.status} ${chosenThumb.via} ${chosenThumb.url}`)
    } else {
        logStep('saveArtPost:thumb-selected', `fallback ${imgSrc || 'none'}`)
    }

    const artPostData = {
        title: chosen.title || '',
        link: normalizeExternalUrl(chosen.url || (chosen.id ? ('https://www.furaffinity.net/view/' + chosen.id + '/') : '')),
        imgSrc
    }

    if (!artPostData.title || !artPostData.link || !artPostData.imgSrc) {
        throw new Error('Art candidate missing title/link/imgSrc')
    }

    await savePostData(artPostData, 'latest-art.json')
    logStep('saveArtPost:done', `ms=${Date.now() - startedAt}`)
}

async function saveVidPost() {
    const startedAt = Date.now()
    logStep('saveVidPost:start')

    let feed = await withTimeout(parser.parseURL(youtubeRssUrl), REQUEST_TIMEOUT_MS, 'YouTube RSS fetch')
    let latestVid = feed.items[0]

    let trim = "yt:video:"
    let vidID = latestVid.id.includes(trim) ? latestVid.id.split(trim)[1] : ""

    let vidPostData = {
        "title" : latestVid.title,
        "link"  : latestVid.link,
        "imgSrc": "https://i.ytimg.com/vi/" + vidID + "/maxresdefault.jpg"
    }

    await savePostData(vidPostData, "latest-vid.json")
    logStep('saveVidPost:done', `ms=${Date.now() - startedAt}`)
}




// --- NOW DO THE STUFF ---
async function main() {
    const startedAt = Date.now()
    logStep('main:start')

    const [artResult, vidResult] = await Promise.allSettled([
        saveArtPost(),
        saveVidPost()
    ])

    if (artResult.status === 'rejected') {
        console.error('[site-scraper] saveArtPost failed:', artResult.reason)
    }
    if (vidResult.status === 'rejected') {
        console.error('[site-scraper] saveVidPost failed:', vidResult.reason)
    }

    logStep('main:done', `ms=${Date.now() - startedAt}`)

    if (artResult.status === 'rejected' || vidResult.status === 'rejected') {
        process.exitCode = 1
    }
}

main().catch((err) => {
    console.error('[site-scraper] fatal error:', err)
    process.exitCode = 1
})