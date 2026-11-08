# Manual setup

This guide covers only the setup that a person must perform when installing
Data Workbench from a fresh repository. Deployment is automated by GitHub
Actions.

## System overview

The application is a React/Vite single-page application deployed as one
Cloudflare Worker:

```text
Browser
  │
  ▼
Data Workbench Worker
  ├── React/Vite static assets
  ├── /api/* Worker endpoints
  └── future private R2 access through a server-side binding
```

Cloudflare Access protects the Worker hostname. The browser never receives R2
credentials; future data requests go through authenticated Worker endpoints.

## Prerequisites

You need:

- A GitHub repository containing this project.
- A Cloudflare account with Workers access.
- Permission to create Cloudflare API tokens and manage Worker Access.
- A person or group who should be allowed to use the application.

## Manual setup steps

### 1. Create the Cloudflare API token

Create an account API token for GitHub Actions. Grant the narrowest available
permission that allows the workflow to deploy the Worker and its static assets.
This is an account-level Workers edit/deploy permission.

Do not commit the token or store it in a repository variable. It is a secret.

### 2. Add GitHub Actions secrets

In the GitHub repository, open:

```text
Settings -> Secrets and variables -> Actions -> Secrets
```

Add these repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use the Cloudflare account ID associated with the Worker. The account ID is not
secret in the same way as the API token, but the workflow expects it as a
repository secret.

### 3. Deploy the repository

Push the repository's `main` branch. GitHub Actions will build and deploy the
Worker automatically. The workflow can also be started manually from:

```text
Actions -> Deploy data-workbench Worker -> Run workflow
```

After the workflow succeeds, open **Workers & Pages** in Cloudflare and select
the deployed Worker. Copy its `workers.dev` hostname. It will have this form:

```text
https://<worker-subdomain>.workers.dev
```

### 4. Enable Cloudflare Zero Trust

If Zero Trust is not already enabled:

1. Open the Cloudflare dashboard.
2. Open **Zero Trust**.
3. Complete the initial Zero Trust setup.
4. Choose the account containing the Worker.

### 5. Protect the Worker with Cloudflare Access

Create an Access policy for the deployed Worker:

1. Open **Workers & Pages**.
2. Select the deployed Worker.
3. Choose **Protect with Access**, **Access**, or the equivalent Worker access
   control.
4. Select protection for the Worker production deployment. If offered, also
   protect Worker previews.
5. Add an **Allow** policy for the intended users. For an initial setup, use
   each administrator's exact email address.
6. Configure a login method. Email one-time PIN is suitable if no organization
   identity provider is configured.

Use the Worker hostname obtained in the previous step. For example:

```text
https://<worker-subdomain>.workers.dev
```

### 6. Verify the authenticated application

Open a private/incognito browser window and visit the Worker hostname:

```text
https://<worker-subdomain>.workers.dev
```

Confirm that:

1. Cloudflare Access displays a login page.
2. An allowed user can authenticate.
3. The Data Workbench application loads.

An unauthenticated request must not be able to use the application or API
without passing the configured Access policy.

## What happens automatically

After the GitHub Actions secrets are configured, the workflow automatically:

1. Checks out the repository.
2. Installs npm dependencies.
3. Builds the React/Vite application into `dist/`.
4. Deploys the Worker and static assets together with Wrangler.

No manual Cloudflare deployment command is required.
