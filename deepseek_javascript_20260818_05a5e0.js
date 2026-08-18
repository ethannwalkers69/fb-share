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
  console.log('✅ Config loaded successfully');
} catch (error) {
  console.error('❌ Error loading config.json:', error.message);
  console.error('Please make sure config.json exists with valid appstate');
  process.exit(1);
}

// Store active tasks
const total = new Map();
let taskIdCounter = 0;

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

app.post('/api/stop', async (req, res) => {
  const { sessionId } = req.body;
  
  if (!sessionId) {
    return res.status(400).json({
      error: 'Missing sessionId'
    });
  }

  try {
    // Find the task by session index
    const entries = Array.from(total.entries());
    const targetEntry = entries[sessionId - 1];
    
    if (!targetEntry) {
      return res.status(404).json({
        error: 'Task not found'
      });
    }

    const [postId, taskData] = targetEntry;
    
    // Mark as stopped
    total.set(postId, {
      ...taskData,
      status: 'stopped'
    });

    console.log(`🛑 Task ${postId} stopped by user`);

    // Remove from map after delay (so user can see it's stopped)
    setTimeout(() => {
      total.delete(postId);
      console.log(`🗑️ Task ${postId} removed from dashboard`);
    }, 3000);

    res.status(200).json({
      status: 200,
      message: 'Task stopped successfully'
    });
  } catch (error) {
    return res.status(500).json({
      status: 500,
      error: error.message || error
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
    status: 'running',
    startedAt: Date.now()
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
  let isStopped = false;

  async function shareSequentially() {
    while (sharedCount < amount && !isStopped) {
      try {
        // Check if task was stopped
        const currentTask = total.get(postId);
        if (currentTask && currentTask.status === 'stopped') {
          isStopped = true;
          console.log(`🛑 Task ${postId} stopped during execution`);
          break;
        }

        await new Promise(resolve => setTimeout(resolve, interval * 1000));
        
        // Check again after delay
        const taskCheck = total.get(postId);
        if (taskCheck && taskCheck.status === 'stopped') {
          isStopped = true;
          console.log(`🛑 Task ${postId} stopped during delay`);
          break;
        }

        const response = await axios.post(
          `https://graph.facebook.com/me/feed?link=https://m.facebook.com/${id}&published=0&access_token=${accessToken}`,
          {},
          { headers, timeout: 30000 }
        );

        if (response.status === 200) {
          sharedCount++;
          const current = total.get(postId);
          if (current && current.status !== 'stopped') {
            total.set(postId, {
              ...current,
              count: sharedCount
            });
            console.log(`📤 Task ${postId}: ${sharedCount}/${amount} shares completed`);
          }
        }
      } catch (error) {
        console.error(`❌ Share error for task ${postId}:`, error.message);
        // Don't stop on individual errors, but log them
        // Check if we should continue
        const taskCheck = total.get(postId);
        if (taskCheck && taskCheck.status === 'stopped') {
          isStopped = true;
          break;
        }
      }
    }

    // Mark as completed only if not stopped
    const current = total.get(postId);
    if (current) {
      if (current.status === 'stopped') {
        console.log(`🛑 Task ${postId} stopped at ${sharedCount}/${amount} shares`);
      } else if (sharedCount >= amount) {
        total.set(postId, {
          ...current,
          status: 'completed'
        });
        console.log(`✅ Task ${postId} completed: ${sharedCount}/${amount} shares`);
        
        // Remove completed task after 5 seconds
        setTimeout(() => {
          total.delete(postId);
          console.log(`🗑️ Task ${postId} removed from dashboard`);
        }, 5000);
      }
    }
  }

  // Start the sharing process
  shareSequentially();

  // Safety timeout - if not stopped or completed, force cleanup
  const safetyTimeout = setTimeout(() => {
    const current = total.get(postId);
    if (current && current.status === 'running') {
      console.log(`⏰ Safety timeout for task ${postId}, forcing completion`);
      total.set(postId, {
        ...current,
        status: 'completed'
      });
      setTimeout(() => {
        total.delete(postId);
      }, 3000);
    }
  }, (amount * interval * 1000) + 30000);

  // Clear safety timeout if task completes or stops
  const checkInterval = setInterval(() => {
    const current = total.get(postId);
    if (current && (current.status === 'completed' || current.status === 'stopped')) {
      clearInterval(checkInterval);
      clearTimeout(safetyTimeout);
    }
  }, 1000);
}

async function getPostID(url) {
  try {
    const response = await axios.post('https://id.traodoisub.com/api.php', 
      `link=${encodeURIComponent(url)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000
      }
    );
    return response.data.id;
  } catch (error) {
    console.error('❌ Error getting post ID:', error.message);
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
      headers,
      timeout: 15000
    });
    const token = response.data.match(/"accessToken":\s*"([^"]+)"/);
    if (token && token[1]) {
      return token[1];
    }
    return null;
  } catch (error) {
    console.error('❌ Error getting access token:', error.message);
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err);
  res.status(500).json({
    status: 500,
    error: 'Internal server error'
  });
});

// Start server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📋 Press Ctrl+C to stop`);
});