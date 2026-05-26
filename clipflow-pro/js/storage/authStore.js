import { db } from './db.js';

const XOR_KEY = 'ClipFlow2024SecureKey';

function xorEncrypt(text) {
  const key = XOR_KEY;
  let result = '';
  for (let i = 0; i < text.length; i++) {
    result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return btoa(result);
}

function xorDecrypt(encoded) {
  try {
    const text = atob(encoded);
    const key = XOR_KEY;
    let result = '';
    for (let i = 0; i < text.length; i++) {
      result += String.fromCharCode(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return result;
  } catch {
    return null;
  }
}

export const authStore = {
  async setToken(platform, tokenData) {
    const encrypted = xorEncrypt(JSON.stringify(tokenData));
    await db.setSetting(`auth_${platform}`, encrypted);
  },

  async getToken(platform) {
    const encrypted = await db.getSetting(`auth_${platform}`);
    if (!encrypted) return null;
    const json = xorDecrypt(encrypted);
    if (!json) return null;
    try {
      const data = JSON.parse(json);
      if (data.expires_at && Date.now() > data.expires_at) {
        if (data.refresh_token) {
          return data;
        }
        await this.removeToken(platform);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  },

  async removeToken(platform) {
    await db.setSetting(`auth_${platform}`, null);
  },

  async isConnected(platform) {
    const token = await this.getToken(platform);
    return !!token && !!token.access_token;
  },

  async updateAccessToken(platform, accessToken, expiresIn) {
    const existing = await this.getToken(platform);
    if (!existing) return;
    await this.setToken(platform, {
      ...existing,
      access_token: accessToken,
      expires_at: Date.now() + expiresIn * 1000,
    });
  },
};
