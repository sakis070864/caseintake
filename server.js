// --- Legal Intake Bot - Backend ---
// FINAL VERSION with Firestore read/write, case numbers, and delete functionality

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid'); // Use a robust library for unique IDs
require('dotenv').config();

// --- Initialize Firebase Admin SDK ---
try {
  let serviceAccount;
  const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
  const localSecretPath = './serviceAccountKey.json';

  if (require('fs').existsSync(renderSecretPath)) {
    console.log('Initializing Firebase with Render secret file...');
    serviceAccount = require(renderSecretPath);
  } else {
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

  // --- *** NEW *** API Route to Generate a Secure, Single-Use Token ---
  app.post('/api/generate-token', async (req, res) => {
    try {
        const token = uuidv4(); // Generate a unique token
        const tokenRef = db.collection('access_tokens').doc(token);

        await tokenRef.set({
            used: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log('Generated new access token:', token);
        res.status(200).json({ success: true, token: token });
    } catch (error) {
        console.error('Error generating token:', error);
        res.status(500).json({ error: 'Failed to generate access token.' });
    }
  });

  // --- *** NEW *** API Route to Verify a Token ---
  app.post('/api/verify-token', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ success: false, error: 'Token is required.' });
        }

        const tokenRef = db.collection('access_tokens').doc(token);
        const tokenDoc = await tokenRef.get();

        if (!tokenDoc.exists) {
            return res.status(404).json({ success: false, error: 'Invalid token.' });
        }

        if (tokenDoc.data().used) {
            return res.status(403).json({ success: false, error: 'This link has already been used.' });
        }

        // Mark the token as used so it cannot be used again
        await tokenRef.update({ used: true });

        res.status(200).json({ success: true, message: 'Token is valid.' });

    } catch (error) {
        console.error('Error verifying token:', error);
        res.status(500).json({ error: 'Failed to verify token.' });
    }
  });


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

          const now = new Date();
          const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
          const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
          const caseNumber = `CI-${datePart}-${randomPart}`;

          const docRef = await db.collection('case_reports').add({
              caseNumber,
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

  // --- API Route to GET all reports ---
  app.get('/api/reports', async (req, res) => {
    try {
        const reportsSnapshot = await db.collection('case_reports').orderBy('createdAt', 'desc').get();
        const reports = [];
        reportsSnapshot.forEach(doc => {
            reports.push({ id: doc.id, ...doc.data() });
        });
        res.status(200).json(reports);
    } catch (error) {
        console.error('Error fetching reports from Firestore:', error);
        res.status(500).json({ error: 'Failed to fetch reports.' });
    }
  });

  // --- API Route to DELETE a report ---
  app.delete('/api/reports/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            return res.status(400).json({ error: 'Document ID is required.' });
        }

        await db.collection('case_reports').doc(id).delete();
        
        console.log('Report with ID deleted: ', id);
        res.status(200).json({ success: true, message: 'Report deleted successfully.' });

    } catch (error) {
        console.error('Error deleting report from Firestore:', error);
        res.status(500).json({ error: 'Failed to delete report.' });
    }
  });

  // --- Secure API Route for Internal Login ---
  app.post('/api/internal-login', (req, res) => {
    const { password } = req.body;
    const INTERNAL_PASSWORD = process.env.INTERNAL_ACCESS_PASSWORD || 'Sakis@1964';

    if (password === INTERNAL_PASSWORD) {
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Incorrect password' });
    }
  });


  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

} catch (error) {
    console.error('Firebase initialization failed:', error);
    process.exit(1);
}
