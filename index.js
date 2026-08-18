const express = require('express');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load configuration - DIRECT APSTATE ONLY
let appstate = null;
try {
  const configData = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
  appstate = JSON.parse(configData); // Diretso na yung appstate string
  if (!appstate || !Array.isArray(appstate)) {
    console.error('Error: Invalid appstate format in config.json');
    process.exit(1);
  }
} catch (error) {
  console.error('Error loading config.json:', error.message);
  process.exit(1);
}

// Store active tasks
const total = new Map();

app.get('/total', (req, res) => {
  const data = Array.from(total.values()).map((link, index) => ({
    session: index + 1,
    url: link.url,
    count: link.count,
    id: link.id,
    target: link.target,
    status: link.status || 'running'
  }));
  res.json(data);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/submit', async (req, res) => {
  const { url, amount, interval } = req.body;

  if (!url || !amount || !interval) {
    return res.status(400).json({
      error: 'Missing url, amount, or interval'
    });
  }

  try {
    const cookies = await convertCookie(JSON.stringify(appstate));
    
    if (!cookies) {
      return res.status(400).json({
        status: 500,
        error: 'Invalid appstate in config'
      });
    }

    await share(cookies, url, parseInt(amount), parseInt(interval));
    res.status(200).json({ status: 200 });
  } catch (err) {
    return res.status(500).json({
      status: 500,
      error: err.message || err
    });
  }
});

async function share(cookies, url, amount, interval) {
  const id = await getPostID(url);
  const accessToken = await getAccessToken(cookies);

  if (!id) {
    throw new Error("Unable to get link id: invalid URL, it's either a private post or visible to friends only");
  }

  const postId = total.has(id) ? id + 1 : id;
  total.set(postId, {
    url,
    id,
    count: 0,
    target: amount,
    status: 'running'
  });

  const headers = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate',
    'connection': 'keep-alive',
    'content-length': '0',
    'cookie': cookies,
    'host': 'graph.facebook.com'
  };

  let sharedCount = 0;

  async function shareSequentially() {
    while (sharedCount < amount) {
      try {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
        
        const response = await axios.post(
          `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
          {},
          { headers }
        );

        if (response.status === 200) {
          sharedCount++;
          const current = total.get(postId);
          if (current) {
            total.set(postId, {
              ...current,
              count: sharedCount
            });
          }
        }
      } catch (error) {
        console.error('Share error:', error.message);
      }
    }

    const current = total.get(postId);
    if (current) {
      total.set(postId, {
        ...current,
        status: 'completed'
      });
    }
  }

  shareSequentially();

  setTimeout(() => {
    const current = total.get(postId);
    if (current && current.status === 'completed') {
      total.delete(postId);
    }
  }, (amount * interval * 1000) + 5000);
}

async function getPostID(url) {
  try {
    const response = await axios.post('https://id.traodoisub.com/api.php', 
      `link=${encodeURIComponent(url)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    return response.data.id;
  } catch (error) {
    return null;
  }
}

async function getAccessToken(cookie) {
  try {
    const headers = {
      'authority': 'business.facebook.com',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      'accept-language': 'vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5',
      'cache-control': 'max-age=0',
      'cookie': cookie,
      'referer': 'https://www.facebook.com/',
      'sec-ch-ua': '".Not/A)Brand";v="99", "Google Chrome";v="103", "Chromium";v="103"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    };
    const response = await axios.get('https://business.facebook.com/content_management', {
      headers
    });
    const token = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (token && token[1]) {
      return token[1];
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function convertCookie(cookie) {
  return new Promise((resolve, reject) => {
    try {
      const cookies = JSON.parse(cookie);
      const sbCookie = cookies.find(c => c.key === "sb");
      if (!sbCookie) {
        reject("Detect invalid appstate please provide a valid appstate");
      }
      const sbValue = sbCookie.value;
      const data = `sb=${sbValue}; ${cookies.slice(1).map(c => `${c.key}=${c.value}`).join('; ')}`;
      resolve(data);
    } catch (error) {
      reject("Error processing appstate please provide a valid appstate");
    }
  });
}

app.listen(5000, () => {
  console.log('Server running on port 5000');
});
