const { chromium } = require('playwright');

(async function () {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
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
      await postPage.waitForTimeout(3000);

      const stats = await postPage.evaluate(() => {
        let likes = 'N/A';
        let comments = 'N/A';

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

        return { likes, comments };
      });

      postData[i].likes = stats.likes;
      postData[i].comments = stats.comments;
    } catch (e) {
      console.log('Could not extract likes/comments for ' + postData[i].link + ':', e.message);
      postData[i].likes = 'N/A';
      postData[i].comments = 'N/A';
    }

    await postPage.close();
  }

  console.log(postData);

  await page.waitForTimeout(10000);
  await browser.close();
})();
