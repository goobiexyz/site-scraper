import fetch from 'node-fetch'
import * as cheerio from 'cheerio'
import fs from 'fs/promises'
import Parser from 'rss-parser'

const ngProfileURL = 'https://goobieng.newgrounds.com/'
const youtubeRssUrl = 'https://www.youtube.com/feeds/videos.xml?channel_id=UC-xSJRpIEmeNXj-em-psGtA'
const saveDir = '/srv/site-scraper/latest-posts'
let parser = new Parser()

// --- GET THE ART ---

// get link to latest art post on newgrounds
async function getLatestArtLink() {
    // get the html
    let response = await fetch(ngProfileURL)
    let body = await response.text()

    // parse with cheerio into DOM object
    const $ = cheerio.load(body)

    // get the link and title
    let artLinkElement =  $('#pod_type_5').find('.item-portalitem-art-small:not(:has(rated-m), :has(rated-a))').first()
    let link = artLinkElement.attr('href')
    let title = artLinkElement.attr('title')

    if (link && title) {
        return {
            "link" : link,
            "title": title
        }
    } else {
        return null
    }
}


// get the src url of the img
async function getImgSrc(url) {
    // get the html
    let response = await fetch(url)
    let body = await response.text()

    // parse with cheerio into DOM object
    const $ = cheerio.load(body)

    // get the image src url
    let imgSrc = $('.art-images').find('img').first().attr('src')

    return imgSrc
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
    let artPostData = await getLatestArtLink()
    if (!artPostData) throw new Error("Error scraping artist profile")
    
    let imgSrc = await getImgSrc(artPostData.link)
    if (!imgSrc) throw new Error("Error getting image src")
    
    artPostData.imgSrc = imgSrc
    
    await savePostData(artPostData, "latest-art.json")
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