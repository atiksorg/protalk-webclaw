// file_upload.js — File upload utility for ProTalk file server.
//
// Uploads screenshots and other files to ProTalk's file server and returns
// a public URL that can be used in API calls instead of base64 data URLs.
//
// Usage:
//   import { uploadScreenshot } from './file_upload.js';
//   const url = await uploadScreenshot(dataUrl);
//
// The upload token is stored in chrome.storage.local (device-local, never synced).

const FILE_SERVER_URL = 'https://file.pro-talk.ru/ptrn';
const UPLOAD_TOKEN_KEY = 'protalk_upload_token';

// Default upload token (can be overridden in settings)
const DEFAULT_UPLOAD_TOKEN = 'patrins_b9b1ae83fe6d82cf301ee33b54bfb02cab62ed82b9f9a1455395bf01655dad94';

/**
 * Get the upload token from storage or use default.
 * @returns {Promise<string>}
 */
async function getUploadToken() {
  return new Promise((resolve) => {
    chrome.storage.local.get([UPLOAD_TOKEN_KEY], (items) => {
      resolve(items[UPLOAD_TOKEN_KEY] || DEFAULT_UPLOAD_TOKEN);
    });
  });
}

/**
 * Convert a data URL to a Blob.
 * @param {string} dataUrl - Data URL (e.g., 'data:image/png;base64,...')
 * @returns {Blob}
 */
function dataUrlToBlob(dataUrl) {
  const [header, base64Data] = dataUrl.split(',');
  const mimeType = header.match(/:(.*?);/)[1];
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Upload a file to ProTalk's file server.
 * @param {string} dataUrl - Data URL of the file to upload
 * @param {string} [filename='screenshot.png'] - Filename for the upload
 * @returns {Promise<string>} - Public URL of the uploaded file
 */
export async function uploadFile(dataUrl, filename = 'screenshot.png') {
  const token = await getUploadToken();
  
  // Convert data URL to Blob
  const blob = dataUrlToBlob(dataUrl);
  
  // Create FormData
  const formData = new FormData();
  formData.append('file', blob, filename);
  
  // Upload
  const response = await fetch(FILE_SERVER_URL, {
    method: 'POST',
    headers: {
      'X-Upload-Token': token
    },
    body: formData
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`File upload failed: HTTP ${response.status} - ${errorText.slice(0, 200)}`);
  }
  
  const result = await response.json();
  
  if (!result.url) {
    throw new Error('File upload failed: No URL in response');
  }
  
  return result.url;
}

/**
 * Upload a screenshot and return the public URL.
 * @param {string} dataUrl - Data URL of the screenshot
 * @returns {Promise<string>} - Public URL of the uploaded screenshot
 */
export async function uploadScreenshot(dataUrl) {
  return uploadFile(dataUrl, 'screenshot.png');
}

/**
 * Check if a string is a data URL (base64 encoded).
 * @param {string} str
 * @returns {boolean}
 */
export function isDataUrl(str) {
  return str && str.startsWith('data:');
}

/**
 * Upload a file if it's a data URL, otherwise return as-is.
 * @param {string} dataUrl - Data URL or regular URL
 * @returns {Promise<string>} - Public URL
 */
export async function uploadIfNeeded(dataUrl) {
  if (!dataUrl || !isDataUrl(dataUrl)) {
    return dataUrl;
  }
  return uploadFile(dataUrl);
}

/**
 * Set the upload token in storage.
 * @param {string} token
 * @returns {Promise<void>}
 */
export async function setUploadToken(token) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [UPLOAD_TOKEN_KEY]: token }, resolve);
  });
}

/**
 * Get the current upload token.
 * @returns {Promise<string>}
 */
export async function getUploadTokenValue() {
  return getUploadToken();
}
