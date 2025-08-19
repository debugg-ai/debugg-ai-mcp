/**
 * Project Analyzer for MCP Server
 * Simplified version of the project analyzer for file system-based analysis
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, dirname, resolve } from 'path';
import { Logger } from './logger.js';

const logger = new Logger({ module: 'projectAnalyzer' });

export interface ProjectAnalysis {
  primaryLanguage: string | undefined;
  testingLanguage: string | undefined;
  testingFramework: string | undefined;
  repoName: string | undefined;
  repoPath: string | undefined;
  branchName: string | undefined;
  framework: string | undefined;
}

export interface LanguageDetectionResult {
  language: string;
  confidence: number;
  evidence: string[];
}

export interface TestingFrameworkResult {
  framework: string;
  confidence: number;
  evidence: string[];
}

export interface CodebaseContext {
  repositoryName: string;
  branchName: string;
  commitHash: string;
  totalFiles: number;
  primaryLanguage: string;
  frameworks: string[];
  testingFramework?: string;
  architecturalPatterns: string[];
  focusAreas: string[];
  timestamp: string;
}

/**
 * Simplified Project Analyzer class
 */
export class ProjectAnalyzer {
  
  /**
   * Analyze project structure from file system
   */
  async analyzeProject(repoPath?: string): Promise<ProjectAnalysis> {
    try {
      const projectPath = repoPath || process.cwd();
      
      if (!existsSync(projectPath)) {
        logger.warn('Project path does not exist', { projectPath });
        return this.emptyAnalysis();
      }

      logger.info('Starting project analysis', { projectPath });

      const primaryLanguage = await this.detectPrimaryLanguage(projectPath);
      const testingFramework = await this.detectTestingFramework(projectPath);
      const testingLanguage = await this.detectTestingLanguage(projectPath, primaryLanguage.language);
      const framework = await this.detectFramework(projectPath);
      const repoName = this.extractRepoName(projectPath);
      const branchName = await this.getCurrentBranch(projectPath);

      return {
        primaryLanguage: primaryLanguage.language,
        testingLanguage: testingLanguage.language,
        testingFramework: testingFramework.framework,
        repoName,
        repoPath: projectPath,
        branchName,
        framework,
      };

    } catch (error) {
      logger.error('Error analyzing project', error);
      return this.emptyAnalysis();
    }
  }

  /**
   * Analyze codebase for context extraction
   */
  async analyzeCodebase(
    repoPath: string,
    repoName: string,
    branchName: string,
    includeChanges: boolean = true
  ): Promise<CodebaseContext | null> {
    try {
      logger.info('Starting codebase analysis', { repoPath, repoName, branchName });

      const analysis = await this.analyzeProject(repoPath);
      const fileCount = await this.countFiles(repoPath);
      const architecturalPatterns = await this.analyzeArchitecturalPatterns(repoPath);
      const focusAreas = await this.identifyFocusAreas(repoPath, analysis);

      // Get frameworks as array
      const frameworks = analysis.framework ? [analysis.framework] : [];
      if (analysis.testingFramework && !frameworks.includes(analysis.testingFramework)) {
        frameworks.push(analysis.testingFramework);
      }

      return {
        repositoryName: repoName,
        branchName,
        commitHash: await this.getCurrentCommitHash(repoPath) || 'unknown',
        totalFiles: fileCount,
        primaryLanguage: analysis.primaryLanguage || 'unknown',
        frameworks,
        testingFramework: analysis.testingFramework,
        architecturalPatterns,
        focusAreas,
        timestamp: new Date().toISOString(),
      };

    } catch (error) {
      logger.error('Error analyzing codebase', error);
      return null;
    }
  }

  /**
   * Detect primary programming language
   */
  private async detectPrimaryLanguage(projectPath: string): Promise<LanguageDetectionResult> {
    const evidence: string[] = [];
    let confidence = 0;
    let detectedLanguage = "unknown";

    try {
      // Check for package.json (JavaScript/TypeScript)
      if (existsSync(join(projectPath, "package.json"))) {
        const packageJson = this.readPackageJson(projectPath);
        if (packageJson) {
          evidence.push("package.json found");
          confidence += 30;

          // Check for TypeScript indicators
          if (packageJson.dependencies?.typescript || 
              packageJson.devDependencies?.typescript ||
              packageJson.dependencies?.["@types/node"] ||
              packageJson.devDependencies?.["@types/node"]) {
            detectedLanguage = "typescript";
            evidence.push("TypeScript dependencies in package.json");
            confidence += 25;
          } else {
            detectedLanguage = "javascript";
            evidence.push("JavaScript project (no TypeScript deps)");
            confidence += 20;
          }
        }
      }

      // Check for tsconfig.json
      if (existsSync(join(projectPath, "tsconfig.json"))) {
        if (detectedLanguage === "unknown") {
          detectedLanguage = "typescript";
          confidence += 35;
        }
        evidence.push("tsconfig.json found");
        confidence += 15;
      }

      // Check for Python indicators
      if (existsSync(join(projectPath, "requirements.txt")) ||
          existsSync(join(projectPath, "pyproject.toml")) ||
          existsSync(join(projectPath, "setup.py"))) {
        if (detectedLanguage === "unknown") {
          detectedLanguage = "python";
          confidence += 40;
        }
        evidence.push("Python project files found");
      }

      // Check for Java indicators
      if (existsSync(join(projectPath, "pom.xml")) ||
          existsSync(join(projectPath, "build.gradle"))) {
        if (detectedLanguage === "unknown") {
          detectedLanguage = "java";
          confidence += 40;
        }
        evidence.push("Java build files found");
      }

      // Check for Go indicators
      if (existsSync(join(projectPath, "go.mod"))) {
        if (detectedLanguage === "unknown") {
          detectedLanguage = "go";
          confidence += 40;
        }
        evidence.push("Go module file found");
      }

      // Check for Rust indicators
      if (existsSync(join(projectPath, "Cargo.toml"))) {
        if (detectedLanguage === "unknown") {
          detectedLanguage = "rust";
          confidence += 40;
        }
        evidence.push("Cargo.toml found");
      }

      // Fallback to file extension analysis
      if (confidence < 30) {
        const fileExtensionResult = await this.analyzeFileExtensions(projectPath);
        if (fileExtensionResult.confidence > confidence) {
          detectedLanguage = fileExtensionResult.language;
          confidence = fileExtensionResult.confidence;
          evidence.push(...fileExtensionResult.evidence);
        }
      }

    } catch (error) {
      logger.warn("Error detecting primary language", error);
      evidence.push("Error during detection");
    }

    return {
      language: detectedLanguage,
      confidence: Math.min(confidence, 100),
      evidence,
    };
  }

  /**
   * Detect testing framework
   */
  private async detectTestingFramework(projectPath: string): Promise<TestingFrameworkResult> {
    const evidence: string[] = [];
    let confidence = 0;
    let framework = "unknown";

    try {
      // Check package.json for testing frameworks
      if (existsSync(join(projectPath, "package.json"))) {
        const packageJson = this.readPackageJson(projectPath);
        if (packageJson) {
          const allDeps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
          };

          // Playwright
          if (allDeps.playwright || allDeps["@playwright/test"]) {
            framework = "playwright";
            evidence.push("Playwright dependencies found");
            confidence += 40;
          }

          // Jest
          if (allDeps.jest || allDeps["@jest/core"]) {
            if (framework === "unknown") {
              framework = "jest";
              confidence += 30;
            }
            evidence.push("Jest testing framework found");
          }

          // Vitest
          if (allDeps.vitest) {
            if (framework === "unknown") {
              framework = "vitest";
              confidence += 30;
            }
            evidence.push("Vitest testing framework found");
          }
        }
      }

      // Check for config files
      const configFiles = [
        { file: "playwright.config.js", framework: "playwright", weight: 35 },
        { file: "playwright.config.ts", framework: "playwright", weight: 35 },
        { file: "jest.config.js", framework: "jest", weight: 25 },
        { file: "jest.config.ts", framework: "jest", weight: 25 },
        { file: "vitest.config.js", framework: "vitest", weight: 25 },
        { file: "vitest.config.ts", framework: "vitest", weight: 25 },
      ];

      for (const config of configFiles) {
        if (existsSync(join(projectPath, config.file))) {
          if (framework === "unknown" || config.weight > confidence) {
            framework = config.framework;
            confidence = Math.max(confidence, config.weight);
          }
          evidence.push(`${config.file} found`);
        }
      }

      // Check for Python testing frameworks
      if (existsSync(join(projectPath, "pytest.ini")) ||
          existsSync(join(projectPath, "pyproject.toml"))) {
        if (framework === "unknown") {
          framework = "pytest";
          confidence += 30;
        }
        evidence.push("Python testing configuration found");
      }

    } catch (error) {
      logger.warn("Error detecting testing framework", error);
      evidence.push("Error during detection");
    }

    return {
      framework,
      confidence: Math.min(confidence, 100),
      evidence,
    };
  }

  /**
   * Detect testing language
   */
  private async detectTestingLanguage(projectPath: string, primaryLanguage: string): Promise<LanguageDetectionResult> {
    // For simplicity, assume testing language matches primary language
    // In a real implementation, we'd analyze test files
    return {
      language: primaryLanguage,
      confidence: 50,
      evidence: [`Assumed same as primary language: ${primaryLanguage}`],
    };
  }

  /**
   * Detect framework
   */
  private async detectFramework(projectPath: string): Promise<string> {
    let detectedFramework = "unknown";

    try {
      // Check for Node.js/JavaScript frameworks
      if (existsSync(join(projectPath, "package.json"))) {
        const packageJson = this.readPackageJson(projectPath);
        if (packageJson) {
          const allDeps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
          };

          // NextJS
          if (allDeps.next || existsSync(join(projectPath, "next.config.js"))) {
            detectedFramework = "nextjs";
          }
          // React
          else if (allDeps.react) {
            detectedFramework = "react";
          }
          // Vue
          else if (allDeps.vue) {
            detectedFramework = "vue";
          }
          // Express.js
          else if (allDeps.express) {
            detectedFramework = "express";
          }
        }
      }

      // Check for Python frameworks
      if (detectedFramework === "unknown") {
        if (existsSync(join(projectPath, "manage.py"))) {
          detectedFramework = "django";
        }
      }

    } catch (error) {
      logger.warn("Error detecting framework", error);
    }

    return detectedFramework;
  }

  /**
   * Analyze file extensions in the project
   */
  private async analyzeFileExtensions(projectPath: string): Promise<LanguageDetectionResult> {
    const extensionCounts = new Map<string, number>();
    const evidence: string[] = [];

    try {
      const files = readdirSync(projectPath, { withFileTypes: true });
      for (const file of files) {
        if (file.isFile()) {
          const ext = extname(file.name).toLowerCase();
          if (ext) {
            extensionCounts.set(ext, (extensionCounts.get(ext) || 0) + 1);
          }
        }
      }

      const sortedExtensions = Array.from(extensionCounts.entries())
        .sort(([,a], [,b]) => b - a);

      if (sortedExtensions.length > 0) {
        const topExtension = sortedExtensions[0][0];
        const count = sortedExtensions[0][1];
        
        const languageMap: Record<string, string> = {
          ".js": "javascript",
          ".ts": "typescript", 
          ".py": "python",
          ".java": "java",
          ".go": "go",
          ".rs": "rust",
        };

        const language = languageMap[topExtension] || "unknown";
        evidence.push(`File extension analysis: ${count} ${topExtension} files`);
        
        return {
          language,
          confidence: Math.min(count * 5, 50),
          evidence,
        };
      }
    } catch (error) {
      logger.warn("Error analyzing file extensions", error);
    }

    return {
      language: "unknown",
      confidence: 0,
      evidence: ["No files analyzed"],
    };
  }

  /**
   * Read and parse package.json if it exists
   */
  private readPackageJson(projectPath: string): any | null {
    try {
      const packageJsonPath = join(projectPath, "package.json");
      if (existsSync(packageJsonPath)) {
        const content = readFileSync(packageJsonPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      logger.warn("Error reading package.json", error);
    }
    return null;
  }

  /**
   * Count files in project (excluding node_modules, .git, etc.)
   */
  private async countFiles(projectPath: string): Promise<number> {
    let count = 0;
    const excludeDirs = new Set(['.git', 'node_modules', '.vscode', 'dist', 'build']);
    
    const countRecursive = (dirPath: string) => {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !excludeDirs.has(entry.name)) {
            countRecursive(join(dirPath, entry.name));
          } else if (entry.isFile()) {
            count++;
          }
        }
      } catch (error) {
        // Skip directories we can't read
      }
    };

    countRecursive(projectPath);
    return count;
  }

  /**
   * Analyze architectural patterns
   */
  private async analyzeArchitecturalPatterns(projectPath: string): Promise<string[]> {
    const patterns: string[] = [];
    
    // Check for common patterns
    if (existsSync(join(projectPath, "src", "components"))) {
      patterns.push("Component-based architecture");
    }
    if (existsSync(join(projectPath, "src", "pages")) || existsSync(join(projectPath, "pages"))) {
      patterns.push("Page-based routing");
    }
    if (existsSync(join(projectPath, "src", "store")) || existsSync(join(projectPath, "store"))) {
      patterns.push("Centralized state management");
    }
    if (existsSync(join(projectPath, "api")) || existsSync(join(projectPath, "src", "api"))) {
      patterns.push("API layer separation");
    }
    
    return patterns;
  }

  /**
   * Identify focus areas for testing
   */
  private async identifyFocusAreas(projectPath: string, analysis: ProjectAnalysis): Promise<string[]> {
    const areas: string[] = [];
    
    // Based on framework
    if (analysis.framework === "react" || analysis.framework === "nextjs") {
      areas.push("Component testing", "User interaction flows");
    }
    if (analysis.framework === "express" || analysis.framework === "django") {
      areas.push("API endpoints", "Database integration");
    }
    
    // Based on structure
    if (existsSync(join(projectPath, "src", "auth"))) {
      areas.push("Authentication flows");
    }
    if (existsSync(join(projectPath, "src", "payment"))) {
      areas.push("Payment processing");
    }
    
    return areas;
  }

  /**
   * Extract repository name from path
   */
  private extractRepoName(projectPath: string): string {
    return projectPath.split('/').pop() || 'unknown';
  }

  /**
   * Get current git branch (simplified)
   */
  private async getCurrentBranch(projectPath: string): Promise<string | undefined> {
    try {
      const gitHeadPath = join(projectPath, '.git', 'HEAD');
      if (existsSync(gitHeadPath)) {
        const headContent = readFileSync(gitHeadPath, 'utf-8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          return headContent.replace('ref: refs/heads/', '');
        }
      }
    } catch (error) {
      logger.debug('Could not determine git branch', error);
    }
    return undefined;
  }

  /**
   * Get current commit hash (simplified)
   */
  private async getCurrentCommitHash(projectPath: string): Promise<string | undefined> {
    try {
      const gitHeadPath = join(projectPath, '.git', 'HEAD');
      if (existsSync(gitHeadPath)) {
        const headContent = readFileSync(gitHeadPath, 'utf-8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          // Read from refs
          const branchRefPath = join(projectPath, '.git', headContent.replace('ref: ', ''));
          if (existsSync(branchRefPath)) {
            return readFileSync(branchRefPath, 'utf-8').trim();
          }
        } else {
          // Direct commit hash
          return headContent;
        }
      }
    } catch (error) {
      logger.debug('Could not determine git commit hash', error);
    }
    return undefined;
  }

  /**
   * Return empty analysis structure
   */
  private emptyAnalysis(): ProjectAnalysis {
    return {
      primaryLanguage: undefined,
      testingLanguage: undefined,
      testingFramework: undefined,
      repoName: undefined,
      repoPath: undefined,
      branchName: undefined,
      framework: undefined,
    };
  }
}