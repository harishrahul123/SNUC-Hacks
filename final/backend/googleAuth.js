const { google } = require('googleapis');

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI in backend env.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function getScopes() {
  // - gmail.readonly: read incoming transaction alert emails
  // - userinfo.email/profile: get the connected Gmail address
  return [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];
}

async function getUserEmailFromOAuth(oauth2Client) {
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data } = await oauth2.userinfo.get();
  return data?.email || null;
}

module.exports = {
  getOAuthClient,
  getScopes,
  getUserEmailFromOAuth,
};

