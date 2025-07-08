// --- Legal Intake Bot - Backend ---
// SECURE VERSION with temporary, single-use credentials and correct CORS policy.

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const admin = require('firebase-admin');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
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
  app.use(express.json({limit: '10mb'}));
  
  // --- Rate Limiter Middleware ---
  const rateLimitStore = new Map();
  const RATE_LIMIT_WINDOW_MS = 60 * 1000;
  const MAX_REQUESTS_PER_WINDOW = 20;

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

  // --- ENDPOINT TO FORMAT THE REPORT ---
  app.post('/api/format-report', rateLimiter, async (req, res) => {
    try {
        const { reportData, reportCreatedAt } = req.body; // <-- Receive timestamp from frontend
        if (!reportData) {
            return res.status(400).json({ error: 'Report data is required.' });
        }
        
        // **FIX**: Use the original report's creation date and time, not the current time.
        const reportDate = reportCreatedAt ? new Date(reportCreatedAt._seconds * 1000) : new Date();
        
        // **FIX**: Format to include both date and time for evidence.
        const formattedDateTime = reportDate.toLocaleString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short'
        });

        const formattingPrompt = `
            You are a Senior Paralegal tasked with converting raw JSON intake data into a formal, well-structured internal memorandum for the Supervising Attorney.
            The memorandum must be clear, professional, and easy to read.

            Follow this exact structure and formatting:
            1.  **MEMORANDUM Header**: Start with a standard memo header. Use the following format exactly, without any asterisks or other formatting on the labels:
                TO: Supervising Attorney
                FROM: Senior Paralegal
                DATE: ${formattedDateTime}
                RE: Case Intake - [Client's Name] Regarding [Briefly describe the case matter]
            2.  **Case Summary**: Write a concise, one-paragraph summary of the client's situation based on their initial statement.
            3.  **Client's Initial Statement**: Include the client's full, unedited initial statement.
            4.  **Intake Interview Q&A**: Format the interview transcript into a clean, readable Q&A list.
            5.  **Key Facts & Timeline**: Extract and list the most critical facts, dates, and figures in a bulleted list.
            6.  **Potential Legal Issues**: Based on the entire report, identify a list of potential legal claims or areas of law that apply.

            Here is the raw JSON data:
            ---
            ${reportData}
            ---
        `;
        
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set.");
        
        const modelName = 'gemini-1.5-flash-latest';
        const API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

        const payload = {
            contents: [{ parts: [{ text: formattingPrompt }] }]
        };

        const geminiResponse = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const geminiData = await geminiResponse.json();
        if (!geminiResponse.ok || !geminiData.candidates || !geminiData.candidates[0].content) {
            const errorMessage = geminiData?.error?.message || 'Google API Error while formatting report.';
            throw new Error(errorMessage);
        }

        res.json({ formattedReport: geminiData.candidates[0].content.parts[0].text });

    } catch (error) {
        console.error('Error in /api/format-report:', error);
        res.status(500).json({ error: error.message });
    }
  });
  
  app.post('/api/save-report', async (req, res) => {
      try {
          const { clientName, clientEmail, clientPhone, reportContent, caseId } = req.body;
          if (!clientName || !clientEmail || !reportContent || !caseId) {
              return res.status(400).json({ error: 'Missing required report data or caseId.' });
          }

          const docRef = await db.collection('case_reports').add({
              caseNumber: caseId,
              clientName,
              clientEmail,
              clientPhone: clientPhone || 'Not provided',
              reportContent, 
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

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

  // --- SECURE LOGIN SYSTEM ---

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
              status: 'active',
              createdAt: admin.firestore.FieldValue.serverTimestamp()
          });

          res.status(200).json({ success: true, caseId, passcode });
      } catch (error) {
          console.error("Error creating intake credentials:", error);
          res.status(500).json({ success: false, error: "Could not create credentials." });
      }
  });

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
