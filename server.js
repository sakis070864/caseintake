// --- Legal Intake Bot - Backend ---
// This server protects your API key and communicates with the Google Gemini API.

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware ---
app.use(cors()); // Allows your React frontend to call this server
app.use(express.json()); // Allows the server to understand JSON requests

// --- API Route ---
// The frontend will send requests to this single endpoint.
app.post('/api/gemini', async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
        throw new Error("GEMINI_API_KEY is not set on the server.");
    }
    
    const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;

    // Forward the request to the Google Gemini API
    const geminiResponse = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }]
      })
    });

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
        console.error("Gemini API Error:", geminiData);
        const errorMsg = geminiData?.error?.message || `Google API Error: ${geminiResponse.status}`;
        throw new Error(errorMsg);
    }
    
    // Send the successful response back to the frontend
    res.json(geminiData);

  } catch (error) {
    console.error('Error in /api/gemini:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Start Server ---
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Ready to receive requests from the frontend.');
});
