# Manual setup

This guide covers the setup that a person must perform when installing Data
Workbench from a fresh repository. Deployment is automated by GitHub Actions.

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
  └── private R2 access through server-side bindings
```

Cloudflare Access protects the Worker hostname. The browser never receives R2,
Cloudflare, or GitHub credentials.

## Prerequisites

You need:

- A GitHub repository containing this project.
- A Cloudflare account with Workers, R2, and D1 access.
- Permission to create Cloudflare API tokens and manage Worker Access.
- A person or group who should be allowed to use the application.

## Manual setup steps

### 1. Create the R2 bucket and upload credentials

In Cloudflare, open **R2 Object Storage** and create the bucket:

```text
data-bridge
```

The bucket must be in the same Cloudflare account used by the Worker and GitHub
Actions. Create an R2 API token or S3-compatible credential with permission to
read and write this bucket. Record the generated values for the GitHub secrets
in the next step:

```text
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY
```

Do not put these credentials in the Worker frontend or commit them.

### 2. Create the Cloudflare API token

Create an account API token for GitHub Actions. Grant the narrowest available
permissions that allow the workflow to deploy the Worker, apply the D1
migration, and use the configured R2 and D1 bindings.

Do not commit the token or store it in a repository variable. It is a secret.

### 3. Add Cloudflare deployment secrets

In the GitHub repository, open:

```text
Settings -> Secrets and variables -> Actions -> Secrets
```

Add these repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

Use the Cloudflare account ID associated with the Worker, R2 bucket, and D1
database. The account ID is not secret in the same way as the API token, but the
workflows expect it as a repository secret.

### 4. Add source-fetcher secrets

The migrated GitHub Actions workflows fetch external data and upload processed
Parquet files directly to R2. Add these secrets in the same GitHub Actions
secrets page:

```text
CLOUDFLARE_R2_ACCESS_KEY_ID
CLOUDFLARE_R2_SECRET_ACCESS_KEY

CNC_USERNAME
CNC_PASSWORD

MEALCONNECT_USERNAME
MEALCONNECT_PASSWORD

WEBDAV_USERNAME
WEBDAV_PASSWORD
```

`CLOUDFLARE_ACCOUNT_ID` is shared by Wrangler deployment and the R2 upload
workflows. There is no separate `CLOUDFLARE_R2_ACCOUNT_ID` secret.

The source credentials are used as follows:

- `CNC_*`: Click & Collect Orders
- `MEALCONNECT_*`: MealConnect OADist and OAOrders
- `WEBDAV_*`: WebDAV anonymous programs, rescue, and warehouse

Keep all of these values as repository secrets. Do not use repository variables,
commit them, or print source data or credentials in workflow logs.

### 5. Create the GitHub token for future refresh orchestration

The Worker will eventually be able to start the source-fetcher workflows. For
that capability, create a GitHub fine-grained personal access token:

1. In GitHub, open **Settings -> Developer settings**.
2. Open **Personal access tokens -> Fine-grained tokens**.
3. Select **Generate new token**.
4. Use the organization `cesmn-org` as the resource owner, if available.
5. Limit repository access to:

   ```text
   cesmn-org/data-workbench
   ```

6. Grant these repository permissions:

   ```text
   Actions: Read and write
   Contents: Read-only
   Metadata: Read-only
   ```

7. Generate the token and copy it immediately.
8. In the repository, open:

   ```text
   Settings -> Secrets and variables -> Actions -> Secrets
   ```

9. Add it as:

   ```text
   ACTIONS_TOKEN
   ```

`Actions: Read and write` is required to dispatch a workflow through GitHub's
workflow-dispatch API. The token must not be placed in frontend code or a
repository variable.

### 6. Deploy the repository

Push the repository's `main` branch. GitHub Actions will build and deploy the
Worker automatically. The workflow can also be started manually from:

```text
Actions -> Deploy data-workbench Worker -> Run workflow
```

The deployment workflow also creates the D1 database named:

```text
data-workbench-plans
```

if it does not already exist, applies the committed migration, and deploys the
Worker with its D1 and R2 bindings. No manual D1 database creation or migration
is required.

After the workflow succeeds, open **Workers & Pages** in Cloudflare and select
the deployed Worker. Copy its `workers.dev` hostname. It will have this form:

```text
https://<worker-subdomain>.workers.dev
```

### 7. Enable Cloudflare Zero Trust

If Zero Trust is not already enabled:

1. Open the Cloudflare dashboard.
2. Open **Zero Trust**.
3. Complete the initial Zero Trust setup.
4. Choose the account containing the Worker.

### 8. Protect the Worker with Cloudflare Access

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

### 9. Verify the authenticated application

Open a private/incognito browser window and visit the Worker hostname:

```text
https://<worker-subdomain>.workers.dev
```

Confirm that:

1. Cloudflare Access displays a login page.
2. An allowed user can authenticate.
3. The Data Workbench application loads.
4. The **R2 Files** screen lists objects after selecting **Refresh**.
5. The **Processing Plans** screen can create a plan from an Access file.

An unauthenticated request must not be able to use the application or API
without passing the configured Access policy.

## What happens automatically

After the GitHub Actions secrets are configured, the deployment workflow
automatically:

1. Checks out the repository.
2. Installs npm dependencies.
3. Creates the D1 database if necessary.
4. Applies D1 migrations.
5. Builds the React/Vite application into `dist/`.
6. Deploys the Worker and static assets together with Wrangler.

The six source-fetcher workflows are separately available for manual
`workflow_dispatch` runs. Each accepts an optional `snapshot_timestamp` input in
this format:

```text
YYYY-MM-DD-HHMMSS
```

If supplied, the workflow uses that timestamp exactly. If omitted, it generates
its own UTC timestamp. Each workflow produces the flat filename format:

```text
<SOURCE>-<TABLE_OR_SHEET>-YYYY-MM-DD-HHMMSS.parquet
```

No manual Cloudflare deployment command is required.
