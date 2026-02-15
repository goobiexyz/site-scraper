import fetch from 'node-fetch'
import * as cheerio from 'cheerio'
import fs from 'fs/promises'
import Parser from 'rss-parser'
import { Login, Gallery } from 'furaffinity-api'

const ngProfileURL = 'https://goobieng.newgrounds.com/'
const youtubeRssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC-xSJRpIEmeNXj-em-psGtA'
const saveDir = '/srv/site-scraper/latest-posts'
let parser = new Parser()


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
    // Login with provided cookies and fetch first page of gallery
    Login('af77c04b-e1d5-4ac0-ad62-159d20bc5d85', '9ae6c256-53ae-41fb-be56-c89301f495a3')

    let results
    try {
        results = await Gallery('GracieArt')
    } catch (err) {
        console.error('Error fetching FurAffinity gallery:', err)
        throw err
    }

    if (!Array.isArray(results) || results.length === 0) {
        throw new Error('No gallery results found for GracieArt')
    }

    // Find first submission with a General rating (debug log ratings)
    let artSubmission = null
    for (const r of results) {
        try {
            const sub = await r.getSubmission()
            const isGeneral = (typeof sub.rating === 'number' && sub.rating === 1) || (typeof sub.rating === 'string' && sub.rating.toLowerCase() === 'general')
            if (sub && isGeneral) {
                artSubmission = sub
                break
            }
        } catch (e) {
            // Skip entries that fail to load
        }
    }

    if (!artSubmission) {
        throw new Error('No general-rated submission found on first gallery page')
    }

    const artPostData = {
        title: artSubmission.title || '',
        link: artSubmission.url || (artSubmission.id ? ('https://www.furaffinity.net/view/' + artSubmission.id + '/') : '')
    }

    const imageCandidates = [
        artSubmission.downloadUrl,
        artSubmission.previewUrl
    ].filter(Boolean)

    if (imageCandidates.length > 0) {
        artPostData.imgSrc = imageCandidates[0]
    }

    await savePostData(artPostData, 'latest-art.json')
}

async function saveVidPost() {
    let feed = await parser.parseURL(youtubeRssUrl)
    let latestVid = feed.items[0]

    let trim = "yt:video:"
    let vidID = latestVid.id.includes(trim) ? latestVid.id.split(trim)[1] : ""

    let vidPostData = {
        "title" : latestVid.title,
        "link"  : latestVid.link,
        "imgSrc": "https://i.ytimg.com/vi/" + vidID + "/maxresdefault.jpg"
    }

    await savePostData(vidPostData, "latest-vid.json")
}




// --- NOW DO THE STUFF ---
saveArtPost()
saveVidPost()