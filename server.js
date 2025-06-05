require('dotenv').config();
const express = require('express');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bodyParser = require('body-parser');
const cheerio = require('cheerio');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { promisify } = require('util');
const writeFileAsync = promisify(fs.writeFile);
const unlinkAsync = promisify(fs.unlink);
const nodemailer = require('nodemailer');
const { ElevenLabsClient } = require("@elevenlabs/elevenlabs-js");
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Add retry logic for axios
const axiosWithRetry = async (url, options, maxRetries = 3) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await axios(url, options);
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      console.log(`Retry ${i + 1}/${maxRetries} for ${url}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }
};

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Initialize ElevenLabs client
if (!process.env.ELEVENLABS_API_KEY) {
  console.error('ELEVENLABS_API_KEY is not set in environment variables');
  process.exit(1);
}

// Log the first few characters of the API key for debugging (safely)
const apiKeyPreview = process.env.ELEVENLABS_API_KEY.substring(0, 4) + '...';
console.log('Initializing ElevenLabs with API key:', apiKeyPreview);

const elevenlabs = new ElevenLabsClient({
  apiKey: process.env.ELEVENLABS_API_KEY,
  baseUrl: 'https://api.elevenlabs.io/v1'
});

// Log all environment variables (for debugging)
console.log('Environment variables loaded:');
Object.keys(process.env).forEach(key => {
  if (key.includes('BREVO') || key.includes('EMAIL') || key.includes('GEMINI') || key.includes('ELEVENLABS')) {
    console.log(`${key}: ${process.env[key] ? '✓ Set' : '✗ Not set'}`);
  }
});

const app = express();
app.use(bodyParser.json());

// Enable CORS for all routes
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    
    // Allow Chrome extension requests
    if (origin.startsWith('chrome-extension://')) {
      return callback(null, true);
    }
    
    // Allow your Render.com domain
    if (origin === 'https://podbackend-d9cg.onrender.com') {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-User-ID'],
  credentials: true
}));

// Configure Brevo API
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
if (!process.env.BREVO_API_KEY || process.env.BREVO_API_KEY.length < 30) {
  console.error('Invalid Brevo API key format. API keys should be longer than 30 characters.');
  process.exit(1);
}
apiKey.apiKey = process.env.BREVO_API_KEY;
console.log('Environment variables status:');
console.log('- BREVO_API_KEY:', process.env.BREVO_API_KEY ? `✓ Configured (${process.env.BREVO_API_KEY.length} chars)` : '✗ Missing');
console.log('- EMAIL_FROM:', process.env.EMAIL_FROM ? '✓ Configured' : '✗ Missing');
console.log('- GEMINI_API_KEY:', process.env.GEMINI_API_KEY ? '✓ Configured' : '✗ Missing');
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// Add a test endpoint
app.get('/test', (req, res) => {
  res.json({ status: 'Server is running!' });
});

app.post('/api/summary', async (req, res) => {
  try {
    const { email, bookmarks } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }
    if (!bookmarks || !Array.isArray(bookmarks) || bookmarks.length === 0) {
      return res.status(400).json({ success: false, error: 'At least one bookmark is required' });
    }
    if (!process.env.BREVO_API_KEY) {
      return res.status(500).json({ success: false, error: 'Brevo API key is not configured' });
    }
    if (!process.env.EMAIL_FROM) {
      return res.status(500).json({ success: false, error: 'Sender email is not configured' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ success: false, error: 'Gemini API key is not configured' });
    }
    
    console.log('Processing summary request:', {
      email,
      bookmarkCount: bookmarks.length,
      brevoApiKeyLength: process.env.BREVO_API_KEY.length,
      senderEmail: process.env.EMAIL_FROM
    });

    const { summary, audioBuffer, audioContentId } = await generateSummaryAndPodcast(bookmarks);
    
    if (!summary) {
      return res.status(500).json({ success: false, error: 'Failed to generate summary' });
    }

    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: email }];
    sendSmtpEmail.sender = { name: "Bookmark Podcast Summarizer", email: process.env.EMAIL_FROM };
    sendSmtpEmail.subject = "Your Weekly Bookmark Summary & Podcast";
    sendSmtpEmail.htmlContent = summary;
    sendSmtpEmail.textContent = summary.replace(/<[^>]*>/g, '');
    if (audioBuffer) {
      sendSmtpEmail.attachment = [{ name: 'weekly-bookmark-podcast.mp3', content: audioBuffer.toString('base64') }];
    }

    console.log('Attempting to send email with Brevo...');
    try {
      const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
      console.log('Email sent successfully:', data);
      res.json({ success: true, message: 'Summary and podcast sent successfully' });
    } catch (brevoError) {
      console.error('Brevo API Error:', {
        message: brevoError.message,
        response: brevoError.response?.data,
        status: brevoError.response?.status
      });
      throw brevoError;
    }
  } catch (error) {
    console.error('Error processing summary request:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({ success: false, error: error.message || 'An error occurred while processing your request' });
  }
});

async function generateSummary(content) {
  try {
    console.log('Generating summary with Gemini...');
    const prompt = `Create a clear and informative summary of the following content. 
    The summary should be well-structured and easy to read.
    Include:
    - A brief introduction to the topic
    - Key points and main ideas
    - Important facts and details
    - A conclusion with main takeaways
    
    Keep it under 200 words but make it comprehensive.
    Use a professional but engaging tone.
    Format it as a well-written article, not a conversation.
    Avoid using conversational language or dialogue.

    Content to summarize:
    ${content}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      const summary = response.data.candidates[0].content.parts[0].text.trim();
      console.log('Summary generated successfully');
      return summary;
    } else {
      throw new Error('Invalid response format from Gemini API');
    }
  } catch (error) {
    console.error('Error generating summary:', error);
    throw error;
  }
}

async function generateConversationalScript(text, title) {
  try {
    const prompt = `Create a natural conversation between two podcast hosts discussing this topic. 
    The hosts should be named Alex and Sarah.
    Make it sound like a casual, engaging discussion.
    Keep it brief (2-3 exchanges) but informative.
    Format each line with the speaker's name followed by a colon.
    Don't include any other text or formatting.

    Topic: ${title}
    Content to discuss: ${text}`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data && response.data.candidates && response.data.candidates[0]) {
      return response.data.candidates[0].content.parts[0].text.trim();
    } else {
      throw new Error('Invalid response format from Gemini API');
    }
  } catch (error) {
    console.error('Error generating conversational script:', error);
    throw error;
  }
}

async function generateSpeech(text, isAlex = true) {
  try {
    console.log('Starting speech generation with ElevenLabs...');
    const formattedText = text
      .replace(/([.!?])\s+/g, '$1\n')
      .replace(/([.!?])\n/g, '$1\n\n')
      .replace(/([A-Z][a-z]+):/g, '$1,')
      .replace(/\s+/g, ' ')
      .replace(/([.!?])\s*([A-Z])/g, '$1\n\n$2')
      .replace(/([^.!?])\s*([A-Z][a-z]+:)/g, '$1\n$2')
      .trim();

    // Use different friendly female voices for both hosts
    const voiceId = isAlex ? "EXAVITQu4vr4xnSDxMaL" : "21m00Tcm4TlvDq8ikWAM"; // Bella for Alex, Rachel for Sarah
    console.log(`Using voice ID: ${voiceId} for ${isAlex ? 'Alex' : 'Sarah'}`);

    // Make direct API call to ElevenLabs
    const response = await axios({
      method: 'POST',
      url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': process.env.ELEVENLABS_API_KEY.trim(),
        'Content-Type': 'application/json'
      },
      data: {
        text: formattedText,
        model_id: "eleven_multilingual_v2"
      },
      responseType: 'arraybuffer'
    });

    const audioBuffer = Buffer.from(response.data);
    console.log('Speech generated successfully');
    return audioBuffer;
  } catch (error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('ElevenLabs API Error:', {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data ? Buffer.from(error.response.data).toString() : undefined
      });
    } else if (error.request) {
      // The request was made but no response was received
      console.error('ElevenLabs Request Error:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('ElevenLabs Error:', error.message);
    }
    throw error;
  }
}

async function generatePodcastAudio(conversation) {
  try {
    console.log('Starting podcast audio generation...');
    console.log('Conversation script:', conversation);
    
    // Split the conversation into Alex and Sarah's parts
    const lines = conversation.split('\n');
    console.log('Number of conversation lines:', lines.length);
    
    const audioBuffers = [];

    for (const line of lines) {
      if (line.trim()) {
        const isAlex = line.startsWith('Alex:');
        const text = line.split(':')[1].trim();
        console.log(`Generating speech for ${isAlex ? 'Alex' : 'Sarah'}:`, text);
        
        try {
          const audio = await generateSpeech(text, isAlex);
          audioBuffers.push(audio);
          console.log('Speech generated successfully for this line');
        } catch (speechError) {
          console.error('Error generating speech for line:', speechError);
          // Continue with other lines even if one fails
          continue;
        }
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error('No audio was generated for any part of the conversation');
    }

    console.log('Combining audio buffers...');
    // Combine all audio buffers
    const combinedAudio = Buffer.concat(audioBuffers);
    const tempAudioPath = path.join(__dirname, 'temp-podcast.mp3');
    await writeFileAsync(tempAudioPath, combinedAudio);
    console.log('Podcast audio file generated successfully');
    return tempAudioPath;
  } catch (error) {
    console.error('Error in generatePodcastAudio:', error);
    throw error;
  }
}

async function generateSummaryAndPodcast(bookmarks) {
  let summary = '<h2>Your Bookmarked Content Summary</h2>';
  let podcastText = 'Welcome to your weekly bookmark summary podcast. I\'ve gathered some interesting content for you today. ';
  let allConversations = [];
  
  for (const bookmark of bookmarks) {
    if (!bookmark.url || !bookmark.url.startsWith('http')) continue;
    try {
      console.log(`Processing bookmark: ${bookmark.url}`);
      const response = await axiosWithRetry(bookmark.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Connection': 'keep-alive',
        },
        timeout: 15000 // Increased timeout
      });
      
      const $ = cheerio.load(response.data);
      const title = bookmark.title || $('title').text() || 'Untitled';
      console.log(`Processing: ${title}`);
      
      let mainContent = '';
      const contentSelectors = [
        'article', '.article', '.post', '.entry', 'main', '.content', '.post-content', '.entry-content',
        '#content', '.main-content', '.article-content', '.story-content', '.post-body', '.entry-body'
      ];

      for (const selector of contentSelectors) {
        const content = $(selector);
        if (content.length > 0) {
          content.find('script, style, nav, footer, header, .ads, .comments, .sidebar, .related, .share, .social, .menu, .navigation').remove();
          mainContent = content.text().trim();
          if (mainContent.length > 100) {
            console.log(`Found content using selector: ${selector}`);
            break;
          }
        }
      }

      if (!mainContent || mainContent.length < 100) {
        console.log('Falling back to body content');
        const bodyContent = $('body');
        bodyContent.find('script, style, nav, footer, header, .ads, .comments, .sidebar, .related, .share, .social, .menu, .navigation').remove();
        mainContent = bodyContent.text().trim();
      }

      mainContent = mainContent.replace(/\s+/g, ' ').replace(/\n+/g, ' ').replace(/[^\w\s.,!?-]/g, ' ').trim();
      console.log(`Content length: ${mainContent.length} characters`);

      if (!mainContent || mainContent.length < 50) {
        throw new Error('Not enough content extracted');
      }

      try {
        console.log('Generating summary with Gemini...');
        const summarizedContent = await generateSummary(mainContent.substring(0, 2000));
        console.log('Generated summary for:', title);

        // Generate conversational script for podcast
        console.log('Generating conversational script...');
        const conversation = await generateConversationalScript(mainContent.substring(0, 2000), title);
        allConversations.push(conversation);
        console.log('Generated conversation script for:', title);

        // Add to email summary
        summary += `
          <div style="margin-bottom: 30px; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #2c3e50;">
              <a href="${bookmark.url}" style="color: #3498db; text-decoration: none;">${title}</a>
            </h3>
            <p style="color: #34495e;">${summarizedContent}</p>
            <small style="color: #7f8c8d;">Bookmarked on: ${new Date(bookmark.dateAdded).toLocaleDateString()}</small>
          </div>
        `;
      } catch (error) {
        console.error('Error generating content for:', title, error);
        summary += `
          <div style="margin-bottom: 30px; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h3 style="margin-top: 0; color: #2c3e50;">
              <a href="${bookmark.url}" style="color: #3498db; text-decoration: none;">${title}</a>
            </h3>
            <p style="color: #e74c3c;">Unable to generate summary: ${error.message}</p>
            <small style="color: #7f8c8d;">Bookmarked on: ${new Date(bookmark.dateAdded).toLocaleDateString()}</small>
          </div>
        `;
      }
    } catch (error) {
      console.error('Error processing bookmark:', error.message);
      summary += `
        <div style="margin-bottom: 30px; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
          <h3 style="margin-top: 0; color: #2c3e50;">
            <a href="${bookmark.url}" style="color: #3498db; text-decoration: none;">${bookmark.title || 'Untitled'}</a>
          </h3>
          <p style="color: #e74c3c;">Unable to fetch content: ${error.message}</p>
          <small style="color: #7f8c8d;">Bookmarked on: ${new Date(bookmark.dateAdded).toLocaleDateString()}</small>
        </div>
      `;
    }
  }

  // Generate podcast audio from all conversations
  let audioBuffer = null;
  if (allConversations.length > 0) {
    try {
      const combinedConversation = allConversations.join('\n\n');
      const tempAudioPath = await generatePodcastAudio(combinedConversation);
      audioBuffer = fs.readFileSync(tempAudioPath);
      await unlinkAsync(tempAudioPath);
    } catch (error) {
      console.error('Error generating podcast audio:', error);
    }
  }

  return { summary, audioBuffer, audioContentId: 'podcast-audio' };
}

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log('Test the server at: http://localhost:3001/test');
});


