// --- Legal Intake Bot - Backend ---
// SECURE VERSION with temporary, single-use credentials.

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const bcrypt = require('bcrypt'); // Added for hashing passcodes
require('dotenv').config();

// --- Initialize Firebase Admin SDK ---
try {
  let serviceAccount;
  const renderSecretPath = '/etc/secrets/serviceAccountKey.json';
  const localSecretPath = './serviceAccountKey.json';

  if (require('fs').existsSync(renderSecretPath)) {
    serviceAccount = require(renderSecretPath);
  } else {
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
  
  // --- Rate Limiter Middleware ---
  const rateLimitStore = new Map();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
  const MAX_REQUESTS_PER_WINDOW = 15;

  const rateLimiter = (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    const userRequests = rateLimitStore.get(ip) || [];
    const recentRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW_MS);

    if (recentRequests.length >= MAX_REQUESTS_PER_WINDOW) {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
    }

    recentRequests.push(now);
    rateLimitStore.set(ip, recentRequests);
    next();
  };

  // --- API Routes ---

  app.get('/', (req, res) => {
    res.send('Backend is alive and running!');
  });

  app.post('/api/gemini', rateLimiter, async (req, res) => {
    try {
      const { prompt, jsonMode = false } = req.body;
      if (!prompt) return res.status(400).json({ error: 'Prompt is required.' });

      const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
      
      const modelName = 'gemini-1.5-flash-latest';
      const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

      const payload = {
        contents: [{ parts: [{ text: prompt }] }]
      };

      if (jsonMode) {
        payload.generationConfig = {
          responseMimeType: "application/json",
        };
      }

      const geminiResponse = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const geminiData = await geminiResponse.json();
      if (!geminiResponse.ok) {
        const errorMessage = geminiData?.error?.message || 'Google API Error';
        throw new Error(errorMessage);
      }
      
      res.json(geminiData);
    } catch (error) {
      console.error('Error in /api/gemini:', error);
      res.status(500).json({ error: error.message });
    }
  });
  
  // MODIFIED: Now requires a caseId to deactivate the login credentials after saving.
  app.post('/api/save-report', async (req, res) => {
      try {
          const { clientName, clientEmail, clientPhone, reportContent, caseId } = req.body;
          if (!clientName || !clientEmail || !reportContent || !caseId) {
              return res.status(400).json({ error: 'Missing required report data or caseId.' });
          }

          // Save the report
          const docRef = await db.collection('case_reports').add({
              caseNumber: caseId, // Use the passed caseId as the caseNumber
              clientName,
              clientEmail,
              clientPhone: clientPhone || 'Not provided',
              reportContent,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          // Deactivate the login credentials
          const loginRef = db.collection('intake_logins').doc(caseId);
          await loginRef.update({ status: 'used' });

          res.status(200).json({ success: true, documentId: docRef.id });
      } catch (error) {
          console.error('Error saving report to Firestore:', error);
          res.status(500).json({ error: 'Failed to save report.' });
      }
  });

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

  app.delete('/api/reports/:id', async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(400).json({ error: 'Document ID is required.' });
        await db.collection('case_reports').doc(id).delete();
        res.status(200).json({ success: true, message: 'Report deleted successfully.' });
    } catch (error) {
        console.error('Error deleting report from Firestore:', error);
        res.status(500).json({ error: 'Failed to delete report.' });
    }
  });

  // --- NEW SECURE LOGIN SYSTEM ---

  // 1. NEW: Endpoint to create temporary login credentials
  app.post('/api/create-intake-credentials', async (req, res) => {
      try {
          const now = new Date();
          const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
          const randomPart = Math.random().toString(36).substring(2, 6).toUpperCase();
          const caseId = `CI-${datePart}-${randomPart}`;
          
          const passcode = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 8);
          const saltRounds = 10;
          const hashedPasscode = await bcrypt.hash(passcode, saltRounds);

          const loginRef = db.collection('intake_logins').doc(caseId);
          await loginRef.set({
              hashedPasscode,
              status: 'active', // active, used
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          res.status(200).json({ success: true, caseId, passcode });
      } catch (error) {
          console.error("Error creating intake credentials:", error);
          res.status(500).json({ success: false, error: "Could not create credentials." });
      }
  });

  // 2. NEW: Endpoint to validate credentials from the chatbot
  app.post('/api/validate-intake-credentials', async (req, res) => {
      try {
          const { caseId, passcode } = req.body;
          if (!caseId || !passcode) {
              return res.status(400).json({ success: false, error: "Case ID and Passcode are required." });
          }

          const loginRef = db.collection('intake_logins').doc(caseId);
          const loginDoc = await loginRef.get();

          if (!loginDoc.exists) {
              return res.status(404).json({ success: false, error: "Invalid login details." });
          }

          const loginData = loginDoc.data();
          if (loginData.status !== 'active') {
              return res.status(403).json({ success: false, error: "This intake session has expired." });
          }

          const isMatch = await bcrypt.compare(passcode, loginData.hashedPasscode);

          if (isMatch) {
              res.status(200).json({ success: true, message: "Login successful." });
          } else {
              res.status(401).json({ success: false, error: "Invalid login details." });
          }
      } catch (error) {
          console.error("Error validating credentials:", error);
          res.status(500).json({ success: false, error: "Server error during validation." });
      }
  });

  app.post('/api/internal-login', (req, res) => {
    const { password } = req.body;
    const correctPassword = process.env.INTERNAL_PASSWORD;
    if (!correctPassword) {
        return res.status(500).json({ success: false, error: 'Internal password is not set on the server.' });
    }
    if (password === correctPassword) {
        res.status(200).json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Incorrect password.' });
    }
  });

  app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
  });

} catch (error) {
    console.error('Firebase initialization failed:', error);
    process.exit(1);
}
