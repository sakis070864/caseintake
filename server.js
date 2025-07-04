// --- Legal Intake Bot - Backend ---
// FINAL VERSION with robust Firestore authentication for Render

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// --- Initialize Firebase Admin SDK ---
// This logic now correctly loads the secret key from Render's "Secret File" path
// and falls back to the local file for testing.
try {
  let serviceAccount;
  const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
  const localSecretPath = './serviceAccountKey.json';

  // Check if the Render secret file path exists
  if (require('fs').existsSync(renderSecretPath)) {
    console.log('Initializing Firebase with Render secret file...');
    serviceAccount = require(renderSecretPath);
  } else {
    // Fallback for local development
    console.log('Initializing Firebase with local service account file...');
    serviceAccount = require(localSecretPath);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();
  console.log('Successfully connected to Firestore database.');

  const app = express();
  const PORT = process.env.PORT || 3001;

  app.use(cors());
  app.use(express.json());

  // --- API Route for Gemini ---
  app.post('/api/gemini', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
      
      const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_API_KEY}`;

      const geminiResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      const geminiData = await geminiResponse.json();
      if (!geminiResponse.ok) throw new Error(geminiData?.error?.message || 'Google API Error');
      
      res.json(geminiData);
    } catch (error) {
      console.error('Error in /api/gemini:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // --- API Route to Save Reports ---
  app.post('/api/save-report', async (req, res) => {
      try {
          const { clientName, clientEmail, clientPhone, reportContent } = req.body;

          if (!clientName || !clientEmail || !reportContent) {
              return res.status(400).json({ error: 'Missing required report data.' });
          }

          const docRef = await db.collection('case_reports').add({
              clientName,
              clientEmail,
              clientPhone: clientPhone || 'Not provided',
              reportContent,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          console.log('Report saved with ID: ', docRef.id);
          res.status(200).json({ success: true, documentId: docRef.id });

      } catch (error) {
          console.error('Error saving report to Firestore:', error);
          res.status(500).json({ error: 'Failed to save report.' });
      }
  });

  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

} catch (error) {
    console.error('Firebase initialization failed:', error);
    process.exit(1);
}
