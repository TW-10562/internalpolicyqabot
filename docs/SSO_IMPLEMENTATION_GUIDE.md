# Microsoft SSO Implementation Guide

**For: Frontend Teams — React Applications**
**Date: 2026-03-12**
**Auth Provider: Microsoft Entra ID (Azure AD)**
**Flow: Popup**

---

## Overview

This guide walks you through replacing your existing authentication (username/password or other) with **Microsoft Single Sign-On (SSO)**. After completing all steps, your users will sign in exclusively using their organization Microsoft account — no more username/password forms.

---

## Before You Begin

### What You Will Receive From Me

I will provide each team with two values. **Do not share these publicly or commit them to git.**

| Item | What It Is | What It Looks Like |
|------|------------|--------------------|
| **Client ID** | A unique identifier for your specific application, registered in Azure | `a1b2c3d4-e5f6-7890-abcd-ef1234567890` |
| **Tenant ID** | An identifier for our organization's Azure Active Directory | `f7g8h9i0-j1k2-3456-lmno-pq7890123456` |

> **Need additional Microsoft permissions?** The standard setup gives you access to the user's name and email. If your app needs more (e.g., calendar access, Teams data), contact me first — do not add extra scopes on your own.

---

## Step 1: Install the Required Packages

Open your terminal, navigate to your project's root directory (where `package.json` is), and run:

```bash
npm install @azure/msal-browser @azure/msal-react
```

**What this does:** This installs two libraries from Microsoft:
- `@azure/msal-browser` — The core authentication library that handles the popup login, tokens, and communication with Microsoft's servers
- `@azure/msal-react` — React-specific wrappers (hooks and components) that make it easy to use MSAL inside React components

**How to verify it worked:** Open your `package.json` file. You should now see both packages listed under `"dependencies"`:

```json
{
  "dependencies": {
    "@azure/msal-browser": "^4.x.x",
    "@azure/msal-react": "^3.x.x",
    // ... your other dependencies
  }
}
```

If you see them there, you're good. Move to Step 2.

---

## Step 2: Set Up Environment Variables

Environment variables let you store sensitive values (like your Client ID and Tenant ID) outside of your code, so they don't accidentally get committed to git.

### 2a. Create or update your `.env` file

In your **project root directory** (the same folder as `package.json`), create a file called `.env` if it doesn't already exist. Add these two lines, replacing the placeholder values with the actual IDs I gave you:

```env
VITE_AZURE_CLIENT_ID=paste-your-client-id-here
VITE_AZURE_TENANT_ID=paste-your-tenant-id-here
```

**Example with real-looking values:**

```env
VITE_AZURE_CLIENT_ID=a1b2c3d4-e5f6-7890-abcd-ef1234567890
VITE_AZURE_TENANT_ID=f7g8h9i0-j1k2-3456-lmno-pq7890123456
```

> **Why the `VITE_` prefix?** Vite only exposes environment variables to your browser code if they start with `VITE_`. Without this prefix, your app cannot read the values.

### 2b. Make sure `.env` is in your `.gitignore`

Open your `.gitignore` file (in the project root) and check that `.env` is listed. If it's not there, add this line:

```
.env
```

**Why?** This prevents your Client ID and Tenant ID from being committed to your git repository. These are sensitive values.

### 2c. (Optional) Create a `.env.example` file

This file serves as documentation for other developers on your team, showing them which environment variables are needed without exposing real values:

```env
VITE_AZURE_CLIENT_ID=your-client-id-here
VITE_AZURE_TENANT_ID=your-tenant-id-here
```

This file **can** be committed to git safely since it contains no real values.

---

## Step 3: Create the MSAL Configuration File

This file tells MSAL how to connect to Microsoft's authentication servers using your Client ID and Tenant ID.

### 3a. Create the folder and file

Inside your `src/` directory, create a new folder called `auth`, then create a file called `msalConfig.ts` inside it:

```
your-project/
├── src/
│   ├── auth/                 <-- Create this folder
│   │   └── msalConfig.ts     <-- Create this file
│   ├── App.tsx
│   ├── main.tsx
│   └── ...
├── .env
├── package.json
└── ...
```

### 3b. Add the configuration code

Copy and paste the following code into `src/auth/msalConfig.ts` — **no modifications needed**, it reads your Client ID and Tenant ID from the `.env` file automatically:

```typescript
import { Configuration, LogLevel, PopupRequest } from "@azure/msal-browser";

// Read Client ID and Tenant ID from environment variables (.env file)
const AZURE_CLIENT_ID = import.meta.env.VITE_AZURE_CLIENT_ID || "";
const AZURE_TENANT_ID = import.meta.env.VITE_AZURE_TENANT_ID || "";

// MSAL Configuration — tells MSAL how to connect to Microsoft
export const msalConfig: Configuration = {
  auth: {
    // Your app's unique identifier (from Azure Portal)
    clientId: AZURE_CLIENT_ID,

    // The Microsoft login URL for your organization
    // This tells MSAL to only allow users from your organization's Azure AD
    authority: `https://login.microsoftonline.com/${AZURE_TENANT_ID}`,

    // Where Microsoft should send the user back after login
    // window.location.origin = your app's URL (e.g., http://localhost:5173)
    redirectUri: window.location.origin,

    // Where to send the user after logout
    postLogoutRedirectUri: window.location.origin,

    // After login, return user to the page they were trying to access
    navigateToLoginRequestUrl: true,
  },
  cache: {
    // Store login state in localStorage so users stay logged in across tabs
    cacheLocation: "localStorage",

    // Set to true only if you need to support Internet Explorer 11
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      // Log errors and warnings to browser console for debugging
      loggerCallback: (level, message, containsPii) => {
        // Never log Personally Identifiable Information
        if (containsPii) return;
        switch (level) {
          case LogLevel.Error:
            console.error("[MSAL]", message);
            break;
          case LogLevel.Warning:
            console.warn("[MSAL]", message);
            break;
        }
      },
      logLevel: LogLevel.Warning,
      piiLoggingEnabled: false,
    },
  },
};

// The permissions your app requests from Microsoft
// These are standard — do NOT add extra scopes without authorization
export const loginRequest: PopupRequest = {
  scopes: [
    "openid",     // Required: allows authentication
    "profile",    // Access to user's name
    "email",      // Access to user's email address
    "User.Read",  // Access to read user's basic profile from Microsoft Graph
  ],
};

// Type definition for the user info returned by Microsoft Graph API
export interface MicrosoftUserInfo {
  displayName: string;         // User's full name (e.g., "Tanaka Taro")
  mail: string | null;         // User's email (can be null for some accounts)
  userPrincipalName: string;   // Fallback email (e.g., "user@company.com")
  id: string;                  // Microsoft's unique ID for this user
}
```

### What each section does:

| Section | Purpose |
|---------|---------|
| `auth` | Connects your app to Microsoft using your Client ID and Tenant ID |
| `cache` | Stores the user's login session in the browser so they don't have to sign in every time they refresh |
| `system` | Configures logging so you can see errors/warnings in the browser console during development |
| `loginRequest` | Defines what information your app is allowed to access (name, email, basic profile) |
| `MicrosoftUserInfo` | A TypeScript type that describes the shape of user data you'll receive from Microsoft |

---

## Step 4: Update Your App Entry Point

Your app's entry point (usually `src/main.tsx`) is where React renders your app. You need to:
1. Create an MSAL instance
2. Initialize it (this is async — it must finish before your app renders)
3. Wrap your app in `MsalProvider` so all components can access authentication

### 4a. Open your entry point file

Open `src/main.tsx` (or wherever your `ReactDOM.createRoot(...).render(...)` call is).

### 4b. Replace or update its contents

Below is the complete updated entry point. **Adapt this to match your existing setup** — keep your existing providers (like React Router, etc.), but add the MSAL parts:

```typescript
import React from "react";
import ReactDOM from "react-dom/client";
import { PublicClientApplication } from "@azure/msal-browser";
import { MsalProvider } from "@azure/msal-react";
import { msalConfig } from "./auth/msalConfig";
import App from "./App";
// Keep your other imports (router, CSS, other providers, etc.)

// --- MSAL SETUP: Add these lines ---

// 1. Create an MSAL instance using your configuration
const msalInstance = new PublicClientApplication(msalConfig);

// 2. Initialize MSAL, then render the app
//    IMPORTANT: The app MUST NOT render until initialize() completes.
//    That's why we put the render inside .then()
msalInstance.initialize().then(() => {

  // 3. Handle any leftover redirect responses (safe to include even though
  //    we use popup flow — prevents edge-case errors)
  msalInstance.handleRedirectPromise().catch((error) => {
    console.error("[MSAL] Redirect error:", error);
  });

  // 4. Render the app wrapped in MsalProvider
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      {/* MsalProvider makes authentication available to all child components */}
      <MsalProvider instance={msalInstance}>
        {/* Keep your existing providers here (Router, Theme, etc.) */}
        <App />
      </MsalProvider>
    </React.StrictMode>
  );
});
```

### Key things to note:

1. **`MsalProvider` must wrap your entire app** — put it outside your other providers (or at the same level as your outermost provider). This makes the `useMsal()` hook available in every component.

2. **The app renders inside `.then()`** — this is critical. If you render the app before MSAL finishes initializing, you'll get errors or a blank screen.

3. **Keep your existing code** — if you already have `<BrowserRouter>`, state providers, or other wrappers, keep them. Just add `MsalProvider` around everything.

**Example with existing BrowserRouter:**

```typescript
msalInstance.initialize().then(() => {
  msalInstance.handleRedirectPromise().catch(console.error);

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <MsalProvider instance={msalInstance}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MsalProvider>
    </React.StrictMode>
  );
});
```

---

## Step 5: Create the Login Component

This is the new login page that replaces your existing username/password form. It shows a single "Sign in with Microsoft" button.

### 5a. Understand the login flow

Here's what happens when a user clicks the button:

```
 1. User clicks "Sign in with Microsoft"
            |
            v
 2. A popup window opens showing Microsoft's login page
            |
            v
 3. User enters their Microsoft email and password in the popup
            |
            v
 4. Microsoft verifies the credentials
            |
            v
 5. The popup closes automatically
            |
            v
 6. Your app receives an authentication response with a token
            |
            v
 7. Your app uses that token to fetch the user's name and email
    from Microsoft Graph API (https://graph.microsoft.com/v1.0/me)
            |
            v
 8. You now have the user's email and name — use them in your app
    (e.g., store in state, send to your backend, redirect to dashboard)
```

### 5b. Create the Login component

Create or replace your login component with the following. This example includes detailed comments explaining every line:

```tsx
import { useState } from "react";
import { useMsal } from "@azure/msal-react";
import { InteractionStatus } from "@azure/msal-browser";
import { loginRequest, MicrosoftUserInfo } from "../auth/msalConfig";

export function Login() {
  // Track whether a login is currently in progress (for showing a spinner)
  const [loading, setLoading] = useState(false);

  // Track error messages to display to the user
  const [error, setError] = useState<string | null>(null);

  // useMsal() gives us access to the MSAL instance and its current status.
  // - instance: used to call loginPopup(), acquireTokenSilent(), etc.
  // - inProgress: tells us if MSAL is currently doing something
  //   (e.g., processing a previous login attempt)
  const { instance, inProgress } = useMsal();

  // If MSAL is busy (e.g., still processing a redirect), disable the button
  const isMsalLoading = inProgress !== InteractionStatus.None;

  const handleMicrosoftLogin = async () => {
    // Show loading state and clear any previous errors
    setLoading(true);
    setError(null);

    try {
      // ── STEP 1: Open the Microsoft login popup ──
      // This opens a new browser window where the user signs in with Microsoft.
      // The function waits (await) until the user completes sign-in or closes the popup.
      // loginRequest contains the scopes (permissions) we defined in msalConfig.ts.
      const response = await instance.loginPopup(loginRequest);

      // If we got an account back, the login was successful
      if (response?.account) {

        // ── STEP 2: Get an access token ──
        // The loginPopup gave us an ID token (proves who the user is),
        // but we need an ACCESS token to call Microsoft's Graph API.
        // acquireTokenSilent gets this token without showing another popup.
        const tokenResponse = await instance.acquireTokenSilent({
          scopes: ["User.Read"],       // We need permission to read user profile
          account: response.account,   // For this specific user
        });

        // ── STEP 3: Fetch user info from Microsoft Graph API ──
        // Microsoft Graph is Microsoft's API for accessing user data.
        // The /me endpoint returns info about the currently signed-in user.
        const graphResponse = await fetch(
          "https://graph.microsoft.com/v1.0/me",
          {
            headers: {
              // Include the access token so Microsoft knows we're authorized
              Authorization: `Bearer ${tokenResponse.accessToken}`,
            },
          }
        );

        // Check if the request was successful (HTTP 200)
        if (!graphResponse.ok) {
          throw new Error("Failed to fetch user info from Microsoft");
        }

        // Parse the JSON response into our MicrosoftUserInfo type
        const userInfo: MicrosoftUserInfo = await graphResponse.json();

        // ── STEP 4: Extract the user's email and name ──
        // Some Microsoft accounts have 'mail' set, others don't.
        // userPrincipalName is always available as a fallback.
        const email = userInfo.mail || userInfo.userPrincipalName;
        const name = userInfo.displayName;

        // Safety check: make sure we actually got an email
        if (!email) {
          throw new Error("Could not get email from Microsoft account");
        }

        // ── STEP 5: Use the user info in your application ──
        //
        //    ┌──────────────────────────────────────────────────────┐
        //    │  THIS IS WHERE YOU ADD YOUR APP-SPECIFIC LOGIC      │
        //    │                                                      │
        //    │  Examples:                                            │
        //    │  - Call your backend API to register/login the user   │
        //    │  - Set user state in your React context or store      │
        //    │  - Navigate to the dashboard                          │
        //    │  - Store user info in localStorage                    │
        //    └──────────────────────────────────────────────────────┘
        //
        console.log("Authenticated user:", { email, name });

        // REPLACE the console.log above with your actual logic. For example:
        // await yourBackendApi.login(email, name);
        // setUser({ email, name });
        // navigate("/dashboard");
      }
    } catch (err) {
      // Handle errors
      if (err instanceof Error) {
        // If the user simply closed the popup without signing in,
        // don't show an error — that's normal behavior
        if (!err.message.includes("user_cancelled")) {
          setError(err.message);
        }
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      // Always stop the loading spinner, whether login succeeded or failed
      setLoading(false);
    }
  };

  return (
    <div>
      {/* Show error message if something went wrong */}
      {error && (
        <p style={{ color: "red", marginBottom: "16px" }}>{error}</p>
      )}

      {/* The sign-in button */}
      <button
        onClick={handleMicrosoftLogin}
        disabled={loading || isMsalLoading}
      >
        {loading || isMsalLoading
          ? "Signing in..."
          : "Sign in with Microsoft"}
      </button>
    </div>
  );
}
```

### 5c. What you get back from Microsoft (the output)

After a successful login, here is exactly what each field in `userInfo` contains:

```
userInfo = {
  displayName: "Tanaka Taro"           // The user's full display name
  mail: "tanaka.taro@company.com"      // Primary email (can be null)
  userPrincipalName: "tanaka@co.com"   // Always present, use as email fallback
  id: "abc123-def456-..."              // Microsoft's unique ID for this user
}
```

You use `email` and `name` from this response to identify the user in your app.

---

## Step 6: Implement Logout

Add a logout button wherever appropriate in your app (e.g., in a header, sidebar, or profile menu).

### 6a. In the component where you want the logout button

```tsx
import { useMsal } from "@azure/msal-react";

function YourHeaderOrSidebar() {
  // Get the MSAL instance
  const { instance } = useMsal();

  // Logout function — opens a popup to sign out from Microsoft
  const handleLogout = () => {
    instance.logoutPopup({
      // After logout, redirect user back to your app's root URL
      postLogoutRedirectUri: window.location.origin,
    });
  };

  return (
    <div>
      {/* ... your other header/sidebar content ... */}
      <button onClick={handleLogout}>
        Sign Out
      </button>
    </div>
  );
}
```

### 6b. What happens when the user clicks "Sign Out"

1. A popup opens briefly to sign the user out of Microsoft
2. The popup closes automatically
3. MSAL clears the cached tokens from localStorage
4. The user is redirected to your app's root URL
5. They will need to sign in again to access the app

### 6c. Clear your own app state on logout

If your app stores user data in React state, context, or localStorage, make sure to clear it when the user logs out:

```tsx
const handleLogout = () => {
  // Clear your app's user state
  setUser(null);
  localStorage.removeItem("your-app-user-data");

  // Then sign out from Microsoft
  instance.logoutPopup({
    postLogoutRedirectUri: window.location.origin,
  });
};
```

---

## Step 7: Remove Old Authentication

Now that SSO is working, remove your old username/password authentication completely.

### 7a. What to remove

Go through your codebase and remove the following:

| What to find | What to do |
|--------------|------------|
| Username/password input fields | Delete the form components |
| Login form `onSubmit` handlers | Delete the handler functions |
| Password validation logic | Delete the validation code |
| API calls to your old login endpoint (e.g., `POST /auth/login`) | Delete these calls |
| Stored credentials in localStorage/sessionStorage (e.g., `localStorage.getItem("password")`) | Delete reads and writes |
| "Forgot password" links or components | Delete entirely |
| "Register" / "Sign up" forms | Delete entirely (users are auto-registered via Microsoft) |

### 7b. What to keep

| Keep | Why |
|------|-----|
| Route guards / protected routes | Still needed — update them to check MSAL state instead of old auth |
| User state management | Still needed — just change how it gets populated (from SSO instead of login form) |
| Session/token storage for your **backend** API | Keep if your backend uses its own tokens; just change how the initial auth happens |

### 7c. Update route guards (if you have them)

If you have route protection (redirecting unauthenticated users to login), update it to check MSAL's state:

```tsx
import { useIsAuthenticated } from "@azure/msal-react";
import { Navigate } from "react-router-dom";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  // useIsAuthenticated() returns true if the user has signed in via Microsoft
  const isAuthenticated = useIsAuthenticated();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
```

---

## Step 8: Test Your Implementation

### 8a. Start your dev server

```bash
npm run dev
```

### 8b. Test checklist

Go through each of these scenarios and verify they work:

| # | Test | Expected Result |
|---|------|-----------------|
| 1 | Click "Sign in with Microsoft" | A popup opens showing the Microsoft login page |
| 2 | Sign in with your org Microsoft account | Popup closes, you are redirected to the app's main page |
| 3 | Open browser console (F12) | You should see the logged `email` and `name` values |
| 4 | Refresh the page after signing in | You should remain signed in (session is cached) |
| 5 | Click "Sign Out" | You are signed out and redirected to the login page |
| 6 | Sign in, then close and reopen the browser | You should remain signed in (localStorage cache) |
| 7 | Try signing in with a personal Microsoft account | Should be rejected (tenant-restricted) |
| 8 | Click "Sign in" then close the popup without signing in | No error shown (popup cancel is handled gracefully) |

### 8c. If something goes wrong

Check the browser console (F12 > Console tab) for messages starting with `[MSAL]`. These give details about what went wrong.

---

## I/O Reference

### Inputs (What your app sends to Microsoft)

| Parameter | Value | Where It's Set |
|-----------|-------|----------------|
| `clientId` | Your Client ID | `.env` file -> `msalConfig.ts` |
| `authority` | `https://login.microsoftonline.com/{your-tenant-id}` | `.env` file -> `msalConfig.ts` |
| `redirectUri` | Your app's URL (automatic) | `msalConfig.ts` -> `window.location.origin` |
| `scopes` | `["openid", "profile", "email", "User.Read"]` | `msalConfig.ts` -> `loginRequest` |

### Outputs (What your app receives from Microsoft)

#### From `loginPopup()` — the initial authentication response

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `account.username` | `string` | User's email address | `"tanaka@company.com"` |
| `account.name` | `string` | User's display name | `"Tanaka Taro"` |
| `account.localAccountId` | `string` | Unique user ID in the tenant | `"abc123-..."` |
| `idToken` | `string` | JWT proving the user's identity | `"eyJ0eX..."` |
| `accessToken` | `string` | Token for calling Microsoft APIs | `"eyJ0eX..."` |

#### From Microsoft Graph API (`/me` endpoint) — detailed user info

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `displayName` | `string` | User's full name | `"Tanaka Taro"` |
| `mail` | `string` or `null` | Primary email address | `"tanaka.taro@company.com"` |
| `userPrincipalName` | `string` | Email fallback (always present) | `"tanaka@company.com"` |
| `id` | `string` | Microsoft's unique ID for this user | `"a1b2c3d4-..."` |

---

## Complete File Structure

After completing all steps, your project should have these new/modified files:

```
your-project/
├── src/
│   ├── auth/
│   │   └── msalConfig.ts         <-- NEW (Step 3)
│   ├── main.tsx                   <-- MODIFIED (Step 4)
│   ├── components/
│   │   └── Login.tsx              <-- REPLACED (Step 5)
│   └── ...
├── .env                           <-- NEW or MODIFIED (Step 2)
├── .env.example                   <-- NEW, optional (Step 2)
├── .gitignore                     <-- VERIFY .env is listed (Step 2)
├── package.json                   <-- MODIFIED by npm install (Step 1)
└── ...
```

---

## Troubleshooting

| Problem | What You See | Cause | How to Fix |
|---------|-------------|-------|------------|
| Popup is blocked | Nothing happens when clicking sign-in, or browser shows "popup blocked" | Browser popup blocker | The button click must directly trigger `loginPopup()` — don't wrap it in a `setTimeout` or chain it after another async call. Users may also need to allow popups for your domain. |
| `interaction_in_progress` | Error in console | User clicked the sign-in button twice, or a previous login attempt is still processing | Disable the button while `inProgress !== InteractionStatus.None` (already handled in the example code) |
| `AADSTS700054` | Error popup: "response_type is not enabled" | The Azure app registration is missing the SPA platform | Contact me — I will fix the Azure Portal configuration |
| `AADSTS50011` | Error popup: "reply URL does not match" | The redirect URI in your code doesn't match what's registered in Azure | Contact me with your app's exact URL (e.g., `http://localhost:5173`) — I will add it to the Azure Portal |
| `user_cancelled` | Error in console (but no visible error to user) | User closed the popup | This is normal. The example code already suppresses this error. |
| Blank popup or infinite loading | Popup opens but stays blank, or app never loads | `initialize()` was not awaited before rendering | Make sure your `ReactDOM.createRoot().render()` is inside the `msalInstance.initialize().then()` callback (see Step 4) |
| App shows login page after refresh | User has to sign in again every time | `cacheLocation` is not set to `"localStorage"` | Check `msalConfig.ts` — the `cache.cacheLocation` should be `"localStorage"` |
| "No account found" on `acquireTokenSilent` | Error after loginPopup succeeds | The account from loginPopup wasn't passed correctly | Make sure you pass `response.account` to `acquireTokenSilent` (see Step 5 code) |

---

## Final Checklist

Use this to confirm everything is complete:

- [ ] Received Client ID and Tenant ID
- [ ] Installed `@azure/msal-browser` and `@azure/msal-react` (Step 1)
- [ ] Added `VITE_AZURE_CLIENT_ID` and `VITE_AZURE_TENANT_ID` to `.env` (Step 2)
- [ ] Confirmed `.env` is in `.gitignore` (Step 2)
- [ ] Created `src/auth/msalConfig.ts` with the configuration (Step 3)
- [ ] Updated `src/main.tsx` with `MsalProvider` and async initialization (Step 4)
- [ ] Replaced login form with Microsoft SSO button (Step 5)
- [ ] Added logout functionality (Step 6)
- [ ] Removed old username/password authentication (Step 7)
- [ ] Passed all test scenarios (Step 8)

---

## Questions or Issues?

| Topic | Action |
|-------|--------|
| Need your Client ID / Tenant ID | Contact me directly |
| Azure Portal errors (`AADSTS...`) | Contact me with the full error code and your app's URL |
| Need additional Microsoft Graph permissions | Contact me — I will coordinate with your team |
| Code implementation questions | Check this guide first, then reach out if still stuck |
