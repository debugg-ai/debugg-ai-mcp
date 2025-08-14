# NPM Publishing Setup Guide

This guide explains how to set up automated NPM publishing for the DebuggAI MCP server.

## Prerequisites

1. NPM account with publishing permissions
2. GitHub repository with appropriate permissions
3. Access to GitHub repository secrets

## Setup Instructions

### 1. Create NPM Access Token

1. Go to [npmjs.com](https://www.npmjs.com) and log in
2. Click on your profile → "Access Tokens"
3. Click "Generate New Token" → "Granular Access Token"
4. Configure the token:
   - **Token Name**: `debugg-ai-mcp-github-actions`
   - **Expiration**: Set appropriate expiration (recommend 1 year)
   - **Scope**: Select the `@debugg-ai` organization
   - **Permissions**: 
     - Packages and scopes: `Read and write`
     - Organizations: `Read`
5. Click "Generate Token" and copy it

### 2. Add NPM Token to GitHub Secrets

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Name: `NPM_TOKEN`
5. Value: Paste the NPM token from step 1
6. Click "Add secret"

### 3. Verify Package Configuration

The `package.json` should have:
```json
{
  "name": "@debugg-ai/debugg-ai-mcp",
  "version": "1.0.15",
  "files": ["dist"],
  "bin": {
    "@debugg-ai/debugg-ai-mcp": "dist/index.js"
  }
}
```

## How It Works

### Automatic Publishing

1. **Trigger**: Push to `main` branch
2. **Version Check**: Workflow checks if the current version exists on NPM
3. **Tests**: Runs all tests to ensure quality
4. **Build**: Compiles TypeScript and prepares distribution
5. **Publish**: Only publishes if the version doesn't exist on NPM
6. **Release**: Creates a GitHub release with the new version

### Manual Version Bump

Use the "Version Bump" workflow:

1. Go to Actions → Version Bump
2. Click "Run workflow"
3. Choose version type: `patch`, `minor`, or `major`
4. Or enter a custom version (e.g., `2.0.0`)
5. The workflow will:
   - Run tests
   - Update package.json version
   - Update CHANGELOG.md
   - Commit and push changes
   - Trigger the publish workflow

## Usage Examples

### Version Bump Scenarios

| Current Version | Bump Type | New Version |
|----------------|-----------|-------------|
| 1.0.15         | patch     | 1.0.16      |
| 1.0.15         | minor     | 1.1.0       |
| 1.0.15         | major     | 2.0.0       |

### Local Development Commands

```bash
# Check what will be published
npm run publish:check

# Bump version locally (for testing)
npm run version:patch
npm run version:minor  
npm run version:major

# Build and test before publishing
npm run build
npm test
```

### Manual Publish (if needed)

```bash
# Login to NPM (one-time setup)
npm login

# Publish manually
npm publish --access public
```

## Troubleshooting

### Common Issues

1. **"Version already exists"**
   - Update the version in package.json
   - Use the Version Bump workflow
   - Or manually run `npm version patch`

2. **"NPM_TOKEN not found"**
   - Verify the secret is added to GitHub
   - Check the secret name matches `NPM_TOKEN`

3. **"Access denied"**
   - Ensure NPM token has correct permissions
   - Verify you have access to the `@debugg-ai` organization

4. **Tests failing**
   - Fix test issues before publishing
   - Tests must pass for publish to proceed

### Workflow Status

Check workflow status at:
`https://github.com/debugg-ai/debugg-ai-mcp/actions`

## Security Notes

- NPM token is stored securely in GitHub Secrets
- Token has minimal required permissions
- Automatic expiration prevents long-term exposure
- Publish only happens after all tests pass

## Support

For issues with publishing:
1. Check GitHub Actions logs
2. Verify NPM token permissions
3. Ensure package.json configuration is correct
4. Review this setup guide