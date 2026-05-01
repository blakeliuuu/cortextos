import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export const ecosystemCommand = new Command('ecosystem')
  .option('--instance <id>', 'Instance ID', 'default')
  .option('--org <name>', 'Organization name (auto-detected if not specified)')
  .option('--output <path>', 'Output file', 'ecosystem.config.js')
  .description('Generate PM2 ecosystem.config.js from agent configs')
  .action(async (options: { instance: string; org?: string; output: string }) => {
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    // BUG-035 (companion fix): same project-root discovery as enable-agent.ts
    // so `cortextos ecosystem` works from outside ~/cortextos.
    let projectRoot: string;
    if (process.env.CTX_FRAMEWORK_ROOT) {
      projectRoot = process.env.CTX_FRAMEWORK_ROOT;
    } else if (process.env.CTX_PROJECT_ROOT) {
      projectRoot = process.env.CTX_PROJECT_ROOT;
    } else {
      const canonical = join(homedir(), 'cortextos');
      projectRoot = existsSync(join(canonical, 'orgs')) ? canonical : process.cwd();
    }

    // Find all agents
    const agents: Array<{ name: string; dir: string; org?: string }> = [];

    // Scan orgs/*/agents/*
    const orgsDir = join(projectRoot, 'orgs');
    if (existsSync(orgsDir)) {
      for (const org of readdirSync(orgsDir, { withFileTypes: true })) {
        if (!org.isDirectory()) continue;
        const agentsDir = join(orgsDir, org.name, 'agents');
        if (!existsSync(agentsDir)) continue;
        for (const agent of readdirSync(agentsDir, { withFileTypes: true })) {
          if (!agent.isDirectory()) continue;
          agents.push({ name: agent.name, dir: join(agentsDir, agent.name), org: org.name });
        }
      }
    }

    if (agents.length === 0) {
      console.log('No agents found. Add agents first: cortextos add-agent <name>');
      return;
    }

    // Determine org: use --org flag, or auto-detect from first agent found
    const detectedOrg = options.org || agents.find(a => a.org)?.org || '';
    if (!detectedOrg) {
      console.error('Could not determine org. Use --org <name>.');
      return;
    }

    // Use dist/ in project root for all scripts
    const distDir = join(projectRoot, 'dist');
    const daemonScript = join(distDir, 'daemon.js');
    const dashboardDir = join(projectRoot, 'dashboard');
    // BUG-019 + cycle-2 finding: require BOTH package.json AND node_modules/.bin/next.
    // Without the second check, running `cortextos ecosystem` before
    // `npm install` in dashboard/ produces a crash-looped PM2 entry that the
    // user sees as "dashboard keeps restarting". Better to silently skip the
    // dashboard entry if its deps aren't installed yet — the user can re-run
    // `cortextos ecosystem` after `npm install` to add it.
    const hasDashboard = existsSync(join(dashboardDir, 'package.json')) &&
      existsSync(join(dashboardDir, 'node_modules', '.bin', 'next'));

    // Generator emits a portable PM2 ecosystem config:
    // - paths resolve at PM2 load time via path/os requires + FRAMEWORK_ROOT
    //   const, so the file works on any machine that places cortextOS at
    //   the resolved root (or sets CTX_FRAMEWORK_ROOT). No /Users/<name>
    //   strings get baked in.
    // - env vars all use process.env.X || 'default' so the calling shell
    //   can override at runtime: `CTX_INSTANCE_ID=other pm2 restart cortextos-daemon`
    //   switches instances without regenerating the file.
    // - max_restarts is intentionally 10 (storm-protection circuit breaker
    //   referenced in the inline comment block below; do not bump without
    //   strengthening upstream crash-handling first).
    //
    // BUG-019 carryover: emit a cortextos-dashboard PM2 entry alongside
    // the daemon so the dashboard runs under PM2 supervision instead of as
    // an orphan `npm run dev &` background shell job. Only added if
    // dashboard/package.json exists.
    const dashboardAppBlock = hasDashboard
      ? `,
    {
      name: 'cortextos-dashboard',
      script: 'npm',
      args: 'run dev',
      cwd: path.join(FRAMEWORK_ROOT, 'dashboard'),
      env: {
        PORT: process.env.PORT || '3000',
      },
      // Dashboard reads its real config from dashboard/.env.local — populated
      // by /onboarding Phase 7. PM2 just supervises the npm process.
      // max_restarts matches the daemon (10) so dashboard storm-protection
      // mirrors daemon storm-protection — see daemon block for the
      // 2026-04-22 storm reference.
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    }`
      : '';

    const content = `// PM2 ecosystem config for cortextOS daemon.
// Portable: paths resolve at load time relative to this file and the user's home.
// Override any value with environment variables before \`pm2 start\`.
//
// Generated by \`cortextos ecosystem\`. Re-run \`cortextos ecosystem\` to regenerate.
// Hand-edits will be overwritten on next regenerate.

const path = require('path');
const os = require('os');

const FRAMEWORK_ROOT = process.env.CTX_FRAMEWORK_ROOT || __dirname;
const PROJECT_ROOT = process.env.CTX_PROJECT_ROOT || FRAMEWORK_ROOT;
const INSTANCE_ID = process.env.CTX_INSTANCE_ID || ${JSON.stringify(options.instance)};
const CTX_ROOT = process.env.CTX_ROOT || path.join(os.homedir(), '.cortextos', INSTANCE_ID);
const CTX_ORG = process.env.CTX_ORG || ${JSON.stringify(detectedOrg)};

module.exports = {
  apps: [
    {
      name: 'cortextos-daemon',
      script: path.join(FRAMEWORK_ROOT, 'dist', 'daemon.js'),
      args: \`--instance \${INSTANCE_ID}\`,
      cwd: FRAMEWORK_ROOT,
      env: {
        CTX_INSTANCE_ID: INSTANCE_ID,
        CTX_ROOT: CTX_ROOT,
        CTX_FRAMEWORK_ROOT: FRAMEWORK_ROOT,
        CTX_PROJECT_ROOT: PROJECT_ROOT,
        CTX_ORG: CTX_ORG,
        // Debug-only: set to '1' to enable SIGUSR2 signal → controlled
        // uncaughtException for testing the crash-visibility path
        // (.daemon-crashed markers + crash-loop operator Telegram alert).
        // Leave '0' in production; enable temporarily to reproduce crash
        // paths during development. \`kill -SIGUSR2 \$(pm2 pid cortextos-daemon)\`
        // then watch the operator chat for "🚨 CRITICAL: daemon crash-looping"
        // after 3 crashes in 15 min.
        CTX_DEBUG_ALLOW_CRASH_TRIGGER: '0',
      },
      // max_restarts + restart_delay is the ultimate crash-storm circuit
      // breaker. If the daemon dies 10 times faster than 5s apart, PM2
      // gives up — the fleet goes fully dead, requiring a manual
      // \`pm2 restart cortextos-daemon\`. That is intentional: storm
      // protection > fleet uptime during a pathological crash loop.
      // The daemon's uncaughtException handler (src/daemon/index.ts)
      // fires a Telegram alert to the operator at 3+ crashes in 15 min —
      // well before this circuit trips. Do NOT raise these values without
      // also strengthening the upstream fix; the 2026-04-22 storm is a
      // reminder that unchecked auto-restart amplifies one bug into a
      // fleet-wide outage.
      max_restarts: 10,
      restart_delay: 5000,
      autorestart: true,
    }${dashboardAppBlock},
  ],
};
`;

    writeFileSync(options.output, content, 'utf-8');
    console.log(`Generated ${options.output} with daemon (manages ${agents.length} agents)${hasDashboard ? ' + dashboard' : ''}`);
    console.log('\nStart with:');
    console.log(`  pm2 start ${options.output}`);
    console.log('  pm2 save');
  });
