#!/usr/bin/env node

function parseArgs(argv) {
  const args = {};

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    args[key] = value;
    i += 1;
  }

  return args;
}

function required(args, key) {
  const value = args[key] ?? process.env[key.toUpperCase().replace(/-/g, "_")];
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }

  return value;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    method: "POST",
  });

  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  return { json, ok: response.ok, status: response.status };
}

async function signIn(projectUrl, anonKey, email, password) {
  return postJson(
    `${projectUrl}/auth/v1/token?grant_type=password`,
    { email, password },
    {
      apikey: anonKey,
    },
  );
}

async function signUp(projectUrl, anonKey, email, password) {
  return postJson(
    `${projectUrl}/auth/v1/signup`,
    { email, password },
    {
      apikey: anonKey,
    },
  );
}

async function claimDevice(projectUrl, anonKey, accessToken, claimCode) {
  return postJson(
    `${projectUrl}/functions/v1/claim-device`,
    { claimCode },
    {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
    },
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const projectUrl = required(args, "project-url").replace(/\/$/, "");
  const anonKey = required(args, "anon-key");
  const email = required(args, "email");
  const password = required(args, "password");
  const claimCode = required(args, "claim-code");

  let auth = await signIn(projectUrl, anonKey, email, password);

  if (!auth.ok) {
    console.log("Sign-in failed, attempting sign-up...");
    const signUpResult = await signUp(projectUrl, anonKey, email, password);

    if (!signUpResult.ok) {
      console.error("Sign-up failed:");
      console.error(JSON.stringify(signUpResult.json, null, 2));
      process.exit(1);
    }

    if (!signUpResult.json?.access_token) {
      console.error(
        "Sign-up succeeded but no access token was returned. Disable email confirmation for dev or confirm the user first.",
      );
      process.exit(1);
    }

    auth = signUpResult;
  }

  const accessToken = auth.json?.access_token;
  if (!accessToken) {
    console.error("No access token returned from Supabase Auth.");
    process.exit(1);
  }

  const claimResult = await claimDevice(projectUrl, anonKey, accessToken, claimCode);
  console.log(JSON.stringify(claimResult.json, null, 2));

  if (!claimResult.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

