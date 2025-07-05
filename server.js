// --- Legal Intake Bot - Backend ---
// FINAL VERSION with Firestore read/write, case numbers, and delete functionality

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// --- Initialize Firebase Admin SDK ---
try {
  let serviceAccount;
  // Path for Render.com's secret files
  const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
  // Path for local development
  const localSecretPath = './serviceAccountKey.json';

  // Check if running in a Render environment
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

  // --- Middleware ---
  app.use(cors()); // Enable Cross-Origin Resource Sharing
  app.use(express.json()); // Parse JSON bodies

  // --- API Route for Gemini ---
  app.post('/api/gemini', async (req, res) => {
    try {
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in the environment variables.");
      
      const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

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

  // --- API Route to Save Reports to Firestore ---
  app.post('/api/save-report', async (req, res) => {
      try {
          const { clientName, clientEmail, clientPhone, reportContent } = req.body;
          if (!clientName || !clientEmail || !reportContent) {
              return res.status(400).json({ error: 'Missing required report data.' });
          }

          // Generate a unique case number
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

  // --- API Route to GET all reports from Firestore ---
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

  // --- API Route to DELETE a report from Firestore ---
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


  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

} catch (error) {
    console.error('Firebase initialization failed:', error);
    process.exit(1); // Exit the process if Firebase can't connect
}
