require('dotenv').config();
const { chromium } = require('playwright');
const https = require('https');

function fetchOpenRouter(prompt, imageUrl) {
    return new Promise((resolve, reject) => {
        const apiKey = process.env.OPENROUTER_API_KEY || '';
        
        let contentPayload = prompt;
        if (imageUrl) {
            contentPayload = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: imageUrl } }
            ];
        }

        const data = JSON.stringify({
            model: 'google/gemma-4-26b-a4b-it',
            messages: [{ role: 'user', content: contentPayload }]
        });

        const req = https.request('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    resolve(parsed.choices?.[0]?.message?.content || 'No explanation generated');
                } catch (e) {
                    console.error('Error parsing OpenRouter response:', e);
                    resolve('Explanation Parse Error');
                }
            });
        });

        req.on('error', (e) => {
            console.error('Network error while fetching OpenRouter response:', e);
            resolve('Explanation Network Error');
        });
        req.write(data);
        req.end();
    });
}


(async function () {
  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    storageState: 'state.json'
  });

  const page = await context.newPage();
  const username = 'nike';

  await page.goto('https://www.instagram.com/' + username + '/');
  await page.waitForSelector('header');

  const followers = await page.locator('a[href$="/followers/"] span').first().innerText();
  console.log('Followers:', followers);

  await page.waitForSelector('a[href*="/p/"], a[href*="/reel/"]', { state: 'visible', timeout: 30000 });
  const posts = await page.locator('a[href*="/p/"], a[href*="/reel/"]').all(); 

  const maxPosts = 6;
  let postData = [];

  for (let i = 0; i < Math.min(posts.length, maxPosts); i++) {
    const post = posts[i];
    const link = await post.getAttribute('href');
    
    let img = null;
    const imgLocator = post.locator('img');
    
    if (await imgLocator.count() > 0) {
      img = await imgLocator.getAttribute('src');
    }

    if (link) {
      postData.push({
        link: 'https://www.instagram.com' + link,
        img
      });
    }
  }

  for (let i = 0; i < postData.length; i++) {
    const postPage = await context.newPage();
    console.log('Extracting data from ' + postData[i].link + '...');
    await postPage.goto(postData[i].link);

    try {
      await postPage.waitForSelector('main', { timeout: 15000 });

      const stats = await postPage.evaluate(() => {
        let likes = 'N/A';
        let comments = 'N/A';
        let captionText = '';
        
        const h1Tags = document.querySelectorAll('h1');
        for (const h1 of h1Tags) {
            if (h1.innerText && h1.innerText.trim().length > 0 && h1.innerText !== 'Instagram' && !h1.innerText.includes('Log in')) {
                captionText = h1.innerText.trim();
                break;
            }
        }
        
        if (!captionText) {
            const metaTitle = document.querySelector('meta[property="og:title"]');
            if (metaTitle) captionText = metaTitle.content;
        }

        const text = document.body.innerText;
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        for (let i = lines.length - 1; i >= 0; i--) {
            let line = lines[i].toLowerCase();

            if (
               line.match(/\s+ago$|^january\s|^february\s|^march\s|^april\s|^may\s|^june\s|^july\s|^august\s|^september\s|^october\s|^november\s|^december\s/i) ||
               line.includes('more posts from') ||
               line.includes('log in to like')
            ) {
                let foundNumbers = [];
                let j = i - 1;
                while (j >= i - 8 && j >= 0 && foundNumbers.length < 2) {       
                    let lineAbove = lines[j];

                    if (/^[\d,.]+([kmbKMB])?$/.test(lineAbove)) {
                        foundNumbers.unshift(lineAbove);
                    }
                    else if (/(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i.test(lineAbove)) {
                       let matcher = lineAbove.match(/(?:view\s*all\s*)?([\d,KMBkmb.]+)\s+comments?/i);
                       if(matcher) foundNumbers.unshift(matcher[1]);
                    }
                    else if (/([\d,KMBkmb.]+)\s+likes?/i.test(lineAbove)) {     
                       if (j + 1 < lines.length && !/reply/i.test(lines[j+1])) {
                           let matcher = lineAbove.match(/([\d,KMBkmb.]+)\s+likes?/i);
                           if(matcher) foundNumbers.unshift(matcher[1]);        
                       }
                    }
                    j--;
                }

                if (foundNumbers.length === 2) {
                    likes = foundNumbers[0];
                    comments = foundNumbers[1];
                    break;
                } else if (foundNumbers.length === 1 && likes === 'N/A') {      
                    likes = foundNumbers[0];
                }
            }
        }

        return { likes, comments, captionText };
      });

      postData[i].likes = stats.likes;
      postData[i].comments = stats.comments;
      postData[i].caption = stats.captionText || 'No caption';
      
      const promptText = `Explain in one short line what this Instagram post is about based on its text and image: "${postData[i].caption}"`;
      console.log('Fetching explanation from OpenRouter...');
      const explanation = await fetchOpenRouter(promptText, postData[i].img);
      postData[i].explanation = explanation.trim();
    } catch (e) {
      console.log('Could not extract likes/comments for ' + postData[i].link + ':', e.message);
      postData[i].likes = 'N/A';
      postData[i].comments = 'N/A';
    }

    await postPage.close();
  }

  console.log(postData);

  await browser.close();
})();
