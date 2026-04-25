# How to authenticate with AWS SSO

Assignee.ai supports AWS Single Sign-On (SSO) profiles configured in
`~/.aws/config`. You do **not** need to export raw access keys when using
SSO — pass the profile name instead.

## Quick start

```bash
# Log in to your SSO session (one-time per session, or when the session expires)
aws sso login --profile enterprise-sso

# Run any Assignee command with the profile
AWS_PROFILE=enterprise-sso assignee plan "Create an S3 bucket"

# Or use the --profile flag on init
assignee init --profile enterprise-sso
```

## Supported credential sources

Assignee resolves operator credentials in this priority order:

1. **`ASSIGNEE_OPERATOR_*` env vars** — highest priority, preferred for
   least-privilege production use. Created by `assignee setup`.
2. **`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`** — auto-promoted to
   the operator role with a warning. Session tokens via `AWS_SESSION_TOKEN`
   are also forwarded.
3. **`AWS_PROFILE` env var or `--profile` flag** — resolved via
   `~/.aws/config` using the AWS SDK provider chain. Supports SSO, assumed
   roles, and static credential profiles.
4. **Default provider chain** — instance metadata (EC2/ECS), etc.

## SSO profile setup

Add an SSO profile to `~/.aws/config`:

```ini
[profile enterprise-sso]
sso_start_url  = https://my-company.awsapps.com/start
sso_region     = us-east-1
sso_account_id = 123456789012
sso_role_name  = DeveloperAccess
region         = us-east-1
```

Then log in once per session:

```bash
aws sso login --profile enterprise-sso
```

After login, pass the profile to Assignee:

```bash
AWS_PROFILE=enterprise-sso assignee plan "..."
AWS_PROFILE=enterprise-sso assignee apply
```

Or set it once in your shell profile (`~/.zshrc` / `~/.bashrc`):

```bash
export AWS_PROFILE=enterprise-sso
```

## Session expiry

SSO sessions typically last 8–12 hours. When the session expires, you
will see:

```
Session expired or invalid for profile "enterprise-sso". Run:
  aws sso login --profile enterprise-sso
```

Re-run `aws sso login --profile <name>` and retry the command.

## Recommended production setup

For production and CI, use `assignee setup` to create least-privilege
`ASSIGNEE_OPERATOR_*` IAM users. SSO profiles are ideal for developer
machines and short-lived CI environments where temporary credentials are
refreshed automatically.

```bash
# For developers: SSO profile (session-limited)
AWS_PROFILE=enterprise-sso assignee plan ...

# For CI/production: dedicated IAM users (long-term, least-privilege)
ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIA...  \
ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=...  \
assignee apply
```

> Note: `assignee setup` creates the `ASSIGNEE_OPERATOR_*`,
> `ASSIGNEE_READER_*`, and `ASSIGNEE_AUDITOR_*` IAM users. This is the
> most secure option for shared environments.
