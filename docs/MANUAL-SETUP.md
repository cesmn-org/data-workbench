# Manual setup

This document describes the one-time setup required for a fresh deployment of
Data Workbench. It documents account configuration and GitHub settings that are
not currently managed by the repository or GitHub Actions.

## Prerequisites

- A GitHub repository containing this project.
- A Cloudflare account with access to the Pages project, the `cesmn.app` zone,
  and Cloudflare Zero Trust.
- A registered domain managed by the same Cloudflare account. This setup uses:

  ```text
  cesmn.app
  ```

- Node.js and npm for local development.

## 1. Create the Cloudflare API token

Create an account API token for the GitHub Actions deployment workflow.

The token must be able to:

- List and create Cloudflare Pages projects.
- Deploy to Cloudflare Pages.

Use the narrowest available Account-level Cloudflare Pages edit permission. Do
not commit the token or put it in a repository variable; it is a secret.

In GitHub, open the repository's:

```text
Settings -> Secrets and variables -> Actions -> Secrets
```

Create these repository secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

`CLOUDFLARE_ACCOUNT_ID` is not sensitive in the same way as the API token, but
this workflow currently expects it as a repository secret.

## 2. Configure GitHub Actions variables

In:

```text
Settings -> Secrets and variables -> Actions -> Variables
```

Create these repository variables:

```text
CLOUDFLARE_PAGES_PROJECT_NAME=data-workbench
CLOUDFLARE_PAGES_PRODUCTION_BRANCH=main
```

The deployment workflow uses these variables when it checks for, creates, and
deploys the Pages project.

## 3. Create or verify the Pages project

The workflow can create the project automatically if it does not exist. It
uses Wrangler's JSON project listing and does not use human-readable command
output to decide whether the project exists.

The expected values are:

```text
Pages project: data-workbench
Production branch: main
```

A maintainer can also create it manually with:

```bash
npx wrangler pages project create data-workbench --production-branch=main
```

Do not create a second project with a different name.

## 4. Deploy and verify the initial application

Push the repository's `main` branch or run the workflow manually from:

```text
Actions -> Deploy data-workbench to Cloudflare Pages -> Run workflow
```

The workflow builds the Vite application and deploys `dist/` to the
`data-workbench` Pages project.

Before enabling access control, verify that the deployment works at the
Cloudflare-provided Pages URL:

```text
https://data-workbench.pages.dev
```

## 5. Add the custom Pages domain

In the Cloudflare dashboard:

1. Open **Workers & Pages**.
2. Select the **`data-workbench`** Pages project.
3. Open **Custom domains**.
4. Select **Set up a domain**.
5. Enter:

   ```text
   data-workbench.cesmn.app
   ```

6. Complete the setup and wait for DNS and certificate activation.

Because `cesmn.app` is managed by the same Cloudflare account, Cloudflare can
usually create the required DNS association automatically. Do not create a
separate guessed CNAME first. If Cloudflare asks for a specific DNS record,
use the exact record it provides.

Verify the custom hostname loads over HTTPS:

```bash
curl -I https://data-workbench.cesmn.app
```

Also open it in a private browser window and confirm the certificate is valid.

## 6. Protect the custom hostname with Cloudflare Access

Create an Access application for the user-facing custom hostname:

1. Open **Zero Trust**.
2. Go to **Access -> Applications**.
3. Select **Add an application**.
4. Choose **Self-hosted**.
5. Set the application domain to:

   ```text
   data-workbench.cesmn.app
   ```

6. Add an **Allow** policy for the intended users. Initially, an exact email
   address is the safest policy.
7. Configure the desired login method. Email one-time PIN is suitable for an
   initial setup if no organization identity provider is configured.

The custom hostname should be the canonical user-facing URL:

```text
https://data-workbench.cesmn.app
```

## 7. Restrict preview deployments

The Pages project has a setting for preview/development deployments:

1. Open **Workers & Pages -> data-workbench -> Settings**.
2. Find **Restrict dev** or the equivalent preview access setting.
3. Enable it and complete the Access policy setup.
4. Use an allow policy for the maintainers who need to view previews.

This setting protects preview hostnames such as:

```text
<deployment-id>.data-workbench.pages.dev
```

It does **not** protect the production Pages hostname:

```text
data-workbench.pages.dev
```

## 8. Block the production `pages.dev` hostname

The production Pages hostname must be handled separately from preview
restrictions.

Create or edit the self-hosted Cloudflare Access application for the exact
production hostname:

```text
data-workbench.pages.dev
```

Important: the destination must be the exact hostname above. Do **not** leave a
wildcard in the subdomain field. A destination such as:

```text
*.data-workbench.pages.dev
```

matches preview subdomains but does not match the production hostname
`data-workbench.pages.dev`.

Configure the policy as:

```text
Action: Block
Include: Everyone
```

Save the Access application and policy. The effective layout should be:

- `data-workbench.cesmn.app` — allowed users through the `initial-admin` (or
  equivalent) policy.
- `data-workbench.pages.dev` — exact hostname, blocked for everyone.
- `*.data-workbench.pages.dev` — preview deployments restricted by the preview
  Access policy.

## 9. Verify access control

Use a private/incognito browser window and test:

```text
https://data-workbench.cesmn.app
https://data-workbench.pages.dev
```

Expected results:

- The custom hostname displays the Cloudflare Access login and then loads the
  application for an allowed user.
- The production `pages.dev` hostname is blocked.

A request without browser cookies can be checked with:

```bash
curl -I https://data-workbench.pages.dev
```

It must not return the application's normal unauthenticated `200` response.

Preview URLs should also require the configured preview Access policy.

## 10. Do not configure the unused zone redirect

A Redirect Rule created under:

```text
cesmn.app -> Rules -> Redirect Rules
```

does not proxy or control the unrelated Cloudflare-owned hostname
`data-workbench.pages.dev`. Do not create a DNS record for `pages.dev` in the
`cesmn.app` zone.

If a trial redirect rule was created while configuring the domain, disable or
delete it after the exact-hostname Access block is working.

## 11. Local development

Install dependencies and start the Vite development server:

```bash
npm ci
npm run dev
```

Build locally before pushing:

```bash
npm run build
```

The repository-owned Access import configuration is committed at:

```text
src/config/access-import.json
```

Do not replace that configuration with browser local storage or require users
to select Access tables manually for each upload.

## 12. Security boundaries

- Never commit `CLOUDFLARE_API_TOKEN`, GitHub tokens, R2 credentials, or Access
  credentials.
- The Pages/Access configuration protects the web application hostnames. It is
  not a substitute for authorization in the future data API.
- Before exposing private R2 data, deploy an authenticated Worker gateway that
  independently authorizes catalog access, object reads, uploads, and refresh
  operations.
- Do not make the R2 bucket public and do not put R2 credentials in browser
  code.

## What is currently automated

The GitHub Actions workflow automates:

- Installing dependencies.
- Building the Vite application.
- Checking whether the Pages project exists using Wrangler JSON output.
- Creating the Pages project if it is absent.
- Deploying `dist/` to Cloudflare Pages.

The following remain manual:

- Cloudflare account/token creation.
- GitHub secret and variable creation.
- Custom domain association.
- Cloudflare Access applications and policies.
- DNS/certificate verification.
- Future R2 and Worker infrastructure setup.
