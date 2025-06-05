# Bookmark Podcast Generator Backend

This is the backend service for the Bookmark Podcast Generator project. It provides the API endpoints for the Chrome extension and web interface. The frontend code is available in a separate repository.

## Project Structure

- **Backend** (this repository): Node.js service that handles bookmark processing, AI summarization, and podcast generation
- **Frontend**: Chrome extension and web interface (available at [podfrontend](https://github.com/Amanyd/aipodcast.git))

## Features

- 📚 Fetches and processes content from bookmarked URLs
- 🤖 Generates concise summaries using Google's Gemini AI
- 🎙️ Creates natural-sounding podcast conversations
- 📧 Sends weekly summaries and podcasts via email
- 🔒 Secure API key management
- 🌐 CORS-enabled for web and extension access

## Prerequisites

- Node.js (v14 or higher)
- API Keys for:
  - Google Gemini AI
  - ElevenLabs
  - Brevo (for email delivery)

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
GEMINI_API_KEY=your_gemini_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM=your_sender_email
PORT=3001
```

## Installation

1. Clone the repository:
```bash
git clone https://github.com/Amanyd/podbackend.git
cd podbackend
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

## API Endpoints

### POST /api/summary
Generates a summary and podcast from bookmarked content.

**Request Body:**
```json
{
  "email": "user@example.com",
  "bookmarks": [
    {
      "url": "https://example.com/article",
      "title": "Article Title",
      "dateAdded": "2024-03-05T12:00:00Z"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Summary and podcast sent successfully"
}
```

### GET /test
Health check endpoint to verify server status.

**Response:**
```json
{
  "status": "Server is running!"
}
```

## Development

- The server runs on port 3001 by default
- CORS is configured to allow requests from:
  - Chrome extensions
  - Your Render.com domain
  - Local development

## Deployment

The application is configured for deployment on Render.com with the following settings:

- **Build Command:** `npm install`
- **Start Command:** `npm start`
- **Root Directory:** `.`

## Error Handling

The service includes comprehensive error handling for:
- Invalid API keys
- Failed content fetching
- Summary generation errors
- Audio generation issues
- Email delivery problems

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## Related Repositories

- [Frontend Repository](https://github.com/Amanyd/podfrontend) - Chrome extension and web interface

## License

This project is licensed under the MIT License - see the LICENSE file for details. 