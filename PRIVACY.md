# Privacy Policy for PawCheck

**Last updated:** August 24, 2026

**PawCheck** protects your privacy. This policy describes how the extension handles user data.

---

### 1. Data Collection and Transmission
- **No Remote Data Transmission**: PawCheck does not transmit any browsing activity, personal data, user credentials, booking details, or analytics to the developer or any third-party server.
- **Local Storage Cache**: The extension stores parsed pet-policy summaries locally in your browser (`chrome.storage.local`) for up to 24 hours. This includes property-ID-keyed records used to avoid repeated search-result requests and the most recent listing summary used as a short-lived popup fallback. Raw page text and extraction details are not persisted. This data remains strictly local on your device.
- **Direct First-Party Network Requests**: When Vrbo search badging is active, the extension fetches public property pages directly from `vrbo.com` using your browser's session. On Vrbo, Airbnb, and Expedia listing pages, policy extraction runs locally against content already loaded in the active page.

---

### 2. Browser Permissions
The extension requests three permissions to perform its core functions:
- **`host_permissions` (`*://*.vrbo.com/*`, `*://*.airbnb.com/*`, `*://*.expedia.com/*`)**: Reads public listing content on supported Vrbo, Airbnb, and Expedia pages to extract pet-policy rules. Vrbo permission also supports optional search-result badging.
- **`storage`**: Stores parsed listing pet policy summaries locally on your device for up to 24 hours. The extension never transmits or shares this cached data.
- **`activeTab`**: Connects the toolbar popup to the active supported listing tab when you click the extension icon or trigger a rescan.

---

### 3. Third-Party Data Sharing
PawCheck does not sell, transfer, or share data with third parties.

---

### 4. Open Source and Support
PawCheck is an open-source project. You can inspect the source code at:  
[https://github.com/curdriceaurora/vrbow](https://github.com/curdriceaurora/vrbow)

If you have questions about this policy, open an issue on the GitHub repository.
