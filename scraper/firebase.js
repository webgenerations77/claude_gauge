const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

let _db = null;

function getDb() {
  if (_db) return _db;

  const serviceAccountPath = path.resolve(
    __dirname,
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './service-account.json'
  );

  if (!fs.existsSync(serviceAccountPath)) {
    console.error(
      `Firebase service account not found at: ${serviceAccountPath}\n` +
        'Download it from Firebase Console → Project Settings → Service accounts → Generate new private key.\n' +
        'Then set FIREBASE_SERVICE_ACCOUNT_PATH in .env'
    );
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(require(serviceAccountPath)),
  });

  _db = admin.firestore();
  return _db;
}

async function upsertUsageRow(row) {
  const db = getDb();
  const docId = `${row.date}_${row.model}`;
  await db
    .collection('usage')
    .doc(docId)
    .set(
      {
        ...row,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  return docId;
}

async function logScrape({ status, rowsUpserted, errorMessage }) {
  const db = getDb();
  await db.collection('scrape_log').add({
    scrapedAt: admin.firestore.FieldValue.serverTimestamp(),
    status,
    rowsUpserted: rowsUpserted || 0,
    errorMessage: errorMessage || null,
  });
}

async function upsertQuota(quota) {
  const db = getDb();
  await db
    .collection('quota')
    .doc('latest')
    .set(
      {
        ...quota,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function upsertClaudeUsage(data) {
  const db = getDb();
  await db
    .collection('claude_usage')
    .doc('latest')
    .set(
      {
        ...data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  const today = new Date().toISOString().split('T')[0];
  await db
    .collection('claude_usage_history')
    .doc(today)
    .set(
      {
        ...data,
        date: today,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function upsertOpenAIUsageRow(row) {
  const db = getDb();
  const docId = `${row.date}_${row.model}`;
  await db
    .collection('openai_usage')
    .doc(docId)
    .set(
      {
        ...row,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  return docId;
}

async function completeScrapeRequests() {
  const db = getDb();
  const pending = await db
    .collection('scrape_requests')
    .where('status', '==', 'pending')
    .get();
  for (const doc of pending.docs) {
    await doc.ref.update({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  return pending.size;
}

module.exports = { getDb, upsertUsageRow, logScrape, upsertQuota, upsertClaudeUsage, upsertOpenAIUsageRow, completeScrapeRequests };
