/* global Buffer -- only reached when atob is missing, i.e. under Node in the unit tests */
/*
 * Knowledge and detectors for the Security checker's active and content checks. Everything here
 * is a pure function over text or URLs that the page agent already fetched, so it is testable in
 * Node. Nothing in this file touches the network.
 *
 * Rules that every detector follows:
 *  - A hit needs a content signature, not just a 200 status. Single-page apps answer unknown
 *    paths with their HTML shell, so status alone proves nothing.
 *  - Evidence never includes secret values. Names, types, lengths and masked prefixes only.
 */
const DFSecProbe = (() => {
  /* ---------- request scope ---------- */

  const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,198}$/;
  // A probe path is a plain absolute path on the scanned origin: no query, no fragment, no dot segments.
  const isSafeProbePath = (p) =>
    typeof p === 'string' && PATH_RE.test(p) && !p.includes('..') && !p.includes('//');

  /* ---------- helpers ---------- */

  const hasText = (res) => !!res && typeof res.text === 'string';
  const ok200 = (res) => hasText(res) && res.status === 200;

  // Cheap content fingerprint: digits and whitespace are dropped so counters and timestamps in a
  // page do not make two copies of the same shell look different.
  function fingerprint(text) {
    const norm = String(text || '')
      .slice(0, 2000)
      .replace(/[\d\s]+/g, '');
    let h = 0x811c9dc5;
    for (let i = 0; i < norm.length; i++) {
      h ^= norm.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // What the site answers for a path that cannot exist. Used to recognise catch-all pages.
  function baselineOf(res) {
    if (!res) return null;
    return {
      status: res.status,
      type: String(res.type || '').split(';')[0].toLowerCase(),
      sig: hasText(res) ? fingerprint(res.text) : null,
    };
  }
  const sameAsBaseline = (res, baseline) =>
    !!baseline && baseline.status === res.status && baseline.sig !== null && baseline.sig === fingerprint(res.text);

  const looksHtml = (res) => /<(!doctype html|html|head|body)\b/i.test(String(res.text || '').slice(0, 600));
  const names = (text, re, max = 12) => {
    const out = [];
    for (const m of text.matchAll(re)) {
      if (!out.includes(m[1])) out.push(m[1]);
      if (out.length >= max) break;
    }
    return out;
  };
  const SECRET_NAME = /(pass(word)?|secret|token|key|credential|auth|private)/i;

  /* ---------- probe catalog ---------- */

  /*
   * test(res, ctx) returns evidence (a string) when the response matches the signature, else null.
   * `tier` is the lowest scan level that includes the probe: "standard" or "advanced".
   */
  const P = (id, path, tier, o) => ({ id, path, tier, ...o });
  const EXPOSURE = {
    category: 'A05',
    theme: 'exposure',
  };

  const PROBES = [
    P('git-head', '/.git/HEAD', 'standard', {
      ...EXPOSURE,
      severity: 'high',
      title: 'Git repository metadata is publicly readable',
      test: (r) => (ok200(r) && /^ref:\s*refs\/heads\/\S+/.test(r.text.trim()) ? 'The file starts with "ref: refs/heads/…", the format of a Git HEAD file.' : null),
      why: 'A reachable .git directory usually lets anyone download the full source code and its history, including old passwords that were committed and later deleted.',
      impact: 'Source code and any secrets in the commit history can be reconstructed, which often leads to deeper access to the application or its servers.',
      fix: 'Remove .git from the web root (deploy a build, not a checkout) and block dot-directories in the web server. Rotate any secret that was ever committed.',
      example: 'nginx:  location ~ /\\.(?!well-known) { deny all; }\nApache: RedirectMatch 404 /\\.(?!well-known)',
      verify: 'Open the address in a private window. Do not download the repository: confirming the first line is enough.',
    }),
    P('git-config', '/.git/config', 'standard', {
      ...EXPOSURE,
      severity: 'high',
      title: 'Git configuration file is publicly readable',
      test: (r) => {
        if (!ok200(r) || !/\[core\]/.test(r.text)) return null;
        const creds = /:\/\/[^/@\s:]+:[^@\s]+@/.test(r.text);
        return 'The file contains a [core] section' + (creds ? ' and a remote address with embedded credentials (not shown).' : '.');
      },
      why: 'The Git configuration can name private repositories and sometimes embeds access tokens in remote addresses.',
      impact: 'Reveals internal repository locations and may leak credentials.',
      fix: 'Block access to .git in the web server and rotate any credential that appears in the file.',
      verify: 'Fetch the address in a private window and check that it is Git configuration text. Do not copy the contents.',
    }),
    P('env-file', '/.env', 'standard', {
      ...EXPOSURE,
      severity: 'high',
      title: 'Environment file (.env) is publicly readable',
      test: (r) => {
        if (!ok200(r) || looksHtml(r)) return null;
        const vars = names(r.text, /^([A-Z][A-Z0-9_]{2,})\s*=/gm);
        if (!vars.length) return null;
        const sensitive = vars.filter((v) => SECRET_NAME.test(v));
        return vars.length + ' variable name(s) such as ' + vars.slice(0, 6).join(', ') + (sensitive.length ? '; ' + sensitive.length + ' look like secrets. Values are not shown or kept.' : '. Values are not shown or kept.');
      },
      why: '.env files normally hold database passwords, API keys and signing secrets.',
      impact: 'Anyone who can read the file may be able to log in to the database or third-party services as the site.',
      fix: 'Move the file outside the web root, deny dot-files in the web server, and rotate every value it contained.',
      example: 'nginx:  location ~ /\\.(?!well-known) { deny all; }',
      verify: 'Check the response in a private window, look only at the variable names, and never copy the values.',
    }),
    P('ds-store', '/.DS_Store', 'standard', {
      ...EXPOSURE,
      severity: 'low',
      title: 'macOS folder metadata file (.DS_Store) is public',
      test: (r) => (ok200(r) && r.text.includes('Bud1') ? 'The file contains the Finder metadata marker "Bud1".' : null),
      why: '.DS_Store files list the file names in a folder, which can reveal hidden pages or backups.',
      impact: 'Helps someone find files that are not linked from the site.',
      fix: 'Delete .DS_Store files from the deployed site and block them in the web server.',
      verify: 'Fetch it in a private window; it is a small binary file that starts with "Bud1".',
    }),
    P('phpinfo', '/phpinfo.php', 'standard', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'phpinfo() page is publicly reachable',
      test: (r) => (ok200(r) && /phpinfo\(\)|PHP Version \d/.test(r.text) ? 'The page shows PHP configuration output.' : null),
      why: 'phpinfo() prints server paths, loaded modules, and environment variables.',
      impact: 'Gives an attacker a detailed map of the server, and environment variables may contain secrets.',
      fix: 'Delete the file from production.',
      verify: 'Open the page and confirm it is the PHP information table.',
    }),
    P('server-status', '/server-status', 'standard', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'Apache server-status page is publicly reachable',
      test: (r) => (ok200(r) && /Apache Server Status/i.test(r.text) ? 'The page shows Apache server status.' : null),
      why: 'The status page lists recent requests, client addresses and the paths people are visiting.',
      impact: 'Leaks visitor activity and internal URLs.',
      fix: 'Restrict /server-status to localhost or an admin network.',
      example: '<Location "/server-status">\n  Require ip 127.0.0.1\n</Location>',
      verify: 'Open the page from a network that should not have access.',
    }),
    P('actuator-env', '/actuator/env', 'standard', {
      ...EXPOSURE,
      severity: 'high',
      title: 'Spring Boot Actuator environment endpoint is exposed',
      test: (r) => (ok200(r) && /"propertySources"/.test(r.text) ? 'The response is a JSON document with "propertySources".' : null),
      why: 'The env endpoint lists configuration properties and may expose credentials.',
      impact: 'Configuration values, internal hostnames and sometimes passwords become readable.',
      fix: 'Do not expose actuator endpoints publicly: set management.endpoints.web.exposure.include to the minimum and put the rest behind authentication.',
      verify: 'Fetch the address and confirm it is Actuator JSON. Do not record the values.',
    }),
    P('actuator-index', '/actuator', 'standard', {
      ...EXPOSURE,
      severity: 'low',
      title: 'Spring Boot Actuator index is exposed',
      test: (r) => (ok200(r) && /"_links"/.test(r.text) && /actuator/i.test(r.text) ? 'The response lists Actuator endpoint links.' : null),
      why: 'The index shows which management endpoints exist.',
      impact: 'Helps an attacker find more sensitive endpoints.',
      fix: 'Limit exposed actuator endpoints and require authentication for them.',
      verify: 'Open the address and read which endpoints are listed.',
    }),
    P('htaccess', '/.htaccess', 'standard', {
      ...EXPOSURE,
      severity: 'low',
      title: 'Web server configuration file (.htaccess) is readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /(RewriteEngine|AuthType|Require\s|Options\s|<Files)/.test(r.text) ? 'The response looks like Apache directives.' : null),
      why: '.htaccess can reveal rewrite rules, protected paths and sometimes credentials files.',
      impact: 'Gives hints about hidden areas of the site.',
      fix: 'Deny access to dot-files in the web server configuration.',
      verify: 'Open the address and check that it is Apache configuration text.',
    }),
    P('crossdomain', '/crossdomain.xml', 'standard', {
      category: 'A05',
      theme: 'cors',
      severity: 'low',
      title: 'crossdomain.xml allows every domain',
      test: (r) => (ok200(r) && /allow-access-from[^>]+domain=["']\*["']/i.test(r.text) ? 'The policy contains allow-access-from domain="*".' : null),
      why: 'This legacy Flash/Acrobat policy lets any site read content from this one.',
      impact: 'Mostly historical, but it signals an overly open cross-origin posture.',
      fix: 'Delete the file, or list specific trusted domains.',
      verify: 'Open the file and read the allow-access-from lines.',
    }),
    P('openapi', '/openapi.json', 'standard', {
      category: 'A05',
      theme: 'exposure',
      severity: 'info',
      title: 'API description (OpenAPI) is public',
      test: (r) => (ok200(r) && /"(openapi|swagger)"\s*:/.test(r.text) ? 'The response is an OpenAPI/Swagger document.' : null),
      why: 'Public API documentation is often intentional, but it also lists every endpoint, including internal ones.',
      impact: 'Makes it easier to find unprotected or deprecated endpoints.',
      fix: 'If the API is not meant to be public, require authentication for the documentation or remove it from production.',
      verify: 'Read the document and check whether it lists admin or internal endpoints.',
    }),
    P('swagger-json', '/swagger.json', 'standard', {
      category: 'A05',
      theme: 'exposure',
      severity: 'info',
      title: 'API description (Swagger) is public',
      test: (r) => (ok200(r) && /"(openapi|swagger)"\s*:/.test(r.text) ? 'The response is an OpenAPI/Swagger document.' : null),
      why: 'Public API documentation is often intentional, but it also lists every endpoint, including internal ones.',
      impact: 'Makes it easier to find unprotected or deprecated endpoints.',
      fix: 'Require authentication for the documentation or remove it from production if the API is private.',
      verify: 'Read the document and check whether it lists admin or internal endpoints.',
    }),
    P('werkzeug-console', '/console', 'standard', {
      category: 'A05',
      theme: 'exposure',
      severity: 'high',
      title: 'Werkzeug interactive debug console is reachable',
      test: (r) => (ok200(r) && /Interactive Console|Werkzeug/i.test(r.text) && /console/i.test(r.text) ? 'The page identifies itself as the Werkzeug interactive console.' : null),
      why: 'The Werkzeug debugger runs Python code on the server. It must never be enabled in production.',
      impact: 'If the console is usable, it can allow code execution on the server. (A PIN normally protects it, but debug mode should still be off.)',
      fix: 'Run Flask/Werkzeug with debug mode disabled in production (FLASK_DEBUG=0) and use a production WSGI server.',
      verify: 'Open the page and confirm it is the console. Do not enter anything into it.',
    }),
    P('phpmyadmin', '/phpmyadmin/', 'standard', {
      category: 'A05',
      theme: 'admin',
      severity: 'low',
      title: 'phpMyAdmin is reachable from the internet',
      test: (r) => (ok200(r) && /phpMyAdmin/i.test(r.text) ? 'The page is a phpMyAdmin login or start page.' : null),
      why: 'Database administration tools are a frequent target for password guessing and for exploits against old versions.',
      impact: 'A weak password or an unpatched version could give database access.',
      fix: 'Restrict it to an admin network or VPN, add a second factor in front of it, keep it updated, or remove it from production.',
      verify: 'Confirm the page is phpMyAdmin and ask who needs it. Do not try to sign in.',
    }),
    P('adminer', '/adminer.php', 'standard', {
      category: 'A05',
      theme: 'admin',
      severity: 'low',
      title: 'Adminer database tool is reachable from the internet',
      test: (r) => (ok200(r) && /Adminer/.test(r.text) && /<form/i.test(r.text) ? 'The page is an Adminer login form.' : null),
      why: 'Database administration tools are a frequent target for password guessing and exploits.',
      impact: 'A weak password or an unpatched version could give database access.',
      fix: 'Remove it from production or restrict it to an admin network.',
      verify: 'Confirm the page is Adminer. Do not try to sign in.',
    }),
    P('wp-login', '/wp-login.php', 'standard', {
      category: 'A07',
      theme: 'admin',
      severity: 'info',
      title: 'WordPress login page is reachable',
      test: (r) => (ok200(r) && /id=["']user_login["']|name=["']wp-submit["']/.test(r.text) ? 'The page is the WordPress login form.' : null),
      why: 'The login page is expected on a WordPress site, but it is the main target of automated password guessing.',
      impact: 'Weak passwords or missing rate limiting can lead to account takeover.',
      fix: 'Use strong unique passwords with two-factor authentication, limit login attempts, and consider restricting wp-login.php by IP.',
      verify: 'Confirm the site is WordPress and check that rate limiting and 2FA are enabled.',
    }),
    P('admin-login', '/admin/', 'standard', {
      category: 'A05',
      theme: 'admin',
      severity: 'info',
      title: 'An administrative login page is reachable',
      test: (r, ctx) =>
        ok200(r) && !sameAsBaseline(r, ctx && ctx.baseline) && /<input[^>]+type=["']password["']/i.test(r.text)
          ? 'The page contains a password field under /admin/.'
          : null,
      why: 'Admin areas that are open to the whole internet get probed constantly.',
      impact: 'Weak credentials or missing rate limiting could lead to full control of the application.',
      fix: 'Restrict the admin area by IP or VPN where possible, require two-factor authentication and limit login attempts.',
      verify: 'Confirm what the page is and whether it needs to be public. Do not attempt to sign in.',
    }),
    P('package-json', '/package.json', 'standard', {
      category: 'A06',
      theme: 'exposure',
      severity: 'info',
      title: 'package.json is publicly readable',
      test: (r) => (ok200(r) && /"(dependencies|devDependencies|scripts)"\s*:/.test(r.text) ? 'The file lists the project dependencies.' : null),
      why: 'Dependency lists tell an attacker exactly which libraries and versions the project uses.',
      impact: 'Makes it easier to look up known vulnerabilities for the exact versions in use.',
      fix: 'Do not deploy build manifests to the public web root.',
      verify: 'Open the file and check the dependency list.',
    }),
    P('composer-json', '/composer.json', 'standard', {
      category: 'A06',
      theme: 'exposure',
      severity: 'info',
      title: 'composer.json is publicly readable',
      test: (r) => (ok200(r) && /"require"\s*:/.test(r.text) ? 'The file lists the project dependencies.' : null),
      why: 'Dependency lists tell an attacker exactly which libraries the project uses.',
      impact: 'Makes it easier to look up known vulnerabilities for the exact versions in use.',
      fix: 'Do not deploy Composer manifests to the public web root.',
      verify: 'Open the file and check the dependency list.',
    }),
    P('dir-uploads', '/uploads/', 'standard', dirProbe('Uploads', 'medium')),
    P('dir-backup', '/backup/', 'standard', dirProbe('Backup', 'medium')),
    P('dir-logs', '/logs/', 'standard', dirProbe('Log', 'medium')),

    // advanced tier
    P('env-local', '/.env.local', 'advanced', envVariant('.env.local')),
    P('env-production', '/.env.production', 'advanced', envVariant('.env.production')),
    P('env-backup', '/.env.bak', 'advanced', envVariant('.env.bak')),
    P('svn-entries', '/.svn/entries', 'advanced', {
      ...EXPOSURE,
      severity: 'high',
      title: 'Subversion metadata is publicly readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /^\d+\s*\n/.test(r.text) && /dir|file/.test(r.text) ? 'The response looks like a Subversion entries file.' : null),
      why: 'A reachable .svn folder can expose the source code and history.',
      impact: 'Source code and secrets may be reconstructed.',
      fix: 'Remove .svn from the web root and block dot-directories.',
      verify: 'Open the address in a private window and check the format only.',
    }),
    P('hg-hgrc', '/.hg/hgrc', 'advanced', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'Mercurial configuration is publicly readable',
      test: (r) => (ok200(r) && /\[paths\]/.test(r.text) ? 'The file contains a [paths] section.' : null),
      why: 'A reachable .hg folder can expose the source code and repository locations.',
      impact: 'Source code and internal repository addresses may be exposed.',
      fix: 'Remove .hg from the web root and block dot-directories.',
      verify: 'Open the address and check the format only.',
    }),
    P('npmrc', '/.npmrc', 'advanced', {
      ...EXPOSURE,
      severity: 'high',
      title: '.npmrc is publicly readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /(_authToken|registry\s*=)/.test(r.text) ? 'The file contains npm registry settings' + (/_authToken/.test(r.text) ? ' including an auth token (not shown).' : '.') : null),
      why: '.npmrc files may hold publish tokens for package registries.',
      impact: 'A leaked token could let someone publish malicious versions of your packages.',
      fix: 'Remove the file from the web root and revoke any token it held.',
      verify: 'Open the address and look at the keys only. Never copy tokens.',
    }),
    P('docker-compose', '/docker-compose.yml', 'advanced', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'docker-compose.yml is publicly readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /^services:\s*$/m.test(r.text) ? 'The file defines Docker services.' : null),
      why: 'Compose files describe internal services, ports and often environment variables with credentials.',
      impact: 'Reveals the internal architecture and may leak passwords.',
      fix: 'Do not deploy infrastructure files to the web root.',
      verify: 'Open the address and check the structure. Do not copy values.',
    }),
    P('dockerfile', '/Dockerfile', 'advanced', {
      category: 'A05',
      theme: 'exposure',
      severity: 'info',
      title: 'Dockerfile is publicly readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /^FROM\s+\S+/m.test(r.text) ? 'The file starts a Docker build.' : null),
      why: 'A Dockerfile shows the base image and build steps.',
      impact: 'Helps an attacker pick known weaknesses in the base image.',
      fix: 'Do not deploy build files to the web root.',
      verify: 'Open the address and check the FROM line.',
    }),
    P('wp-config-bak', '/wp-config.php.bak', 'advanced', configBackup('wp-config.php.bak')),
    P('wp-config-tilde', '/wp-config.php~', 'advanced', configBackup('wp-config.php~')),
    P('config-bak', '/config.php.bak', 'advanced', configBackup('config.php.bak')),
    P('web-config', '/web.config', 'advanced', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'web.config is publicly readable',
      test: (r) => (ok200(r) && /<configuration[\s>]/.test(r.text) ? 'The response is an IIS configuration file.' : null),
      why: 'web.config can contain connection strings and machine keys.',
      impact: 'May leak credentials or signing keys.',
      fix: 'IIS blocks this by default; find out why it is being served and fix the handler mapping.',
      verify: 'Open the address and confirm it is XML configuration. Do not copy values.',
    }),
    P('web-inf', '/WEB-INF/web.xml', 'advanced', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'WEB-INF/web.xml is publicly readable',
      test: (r) => (ok200(r) && /<web-app[\s>]/.test(r.text) ? 'The response is a Java web descriptor.' : null),
      why: 'WEB-INF must never be served; it holds application configuration.',
      impact: 'Reveals application structure and sometimes secrets.',
      fix: 'Fix the servlet container or proxy configuration so WEB-INF is never reachable.',
      verify: 'Confirm it is XML configuration. Do not copy values.',
    }),
    P('appsettings', '/appsettings.json', 'advanced', {
      ...EXPOSURE,
      severity: 'medium',
      title: 'appsettings.json is publicly readable',
      test: (r) => (ok200(r) && /"(ConnectionStrings|Logging|AllowedHosts)"\s*:/.test(r.text) ? 'The file looks like ASP.NET configuration.' : null),
      why: 'ASP.NET settings files often contain connection strings.',
      impact: 'May leak database credentials.',
      fix: 'Keep configuration files out of the static web root.',
      verify: 'Open the address and look at the keys only.',
    }),
    P('sql-dump', '/dump.sql', 'advanced', sqlBackup('dump.sql')),
    P('sql-backup', '/backup.sql', 'advanced', sqlBackup('backup.sql')),
    P('sql-db', '/db.sql', 'advanced', sqlBackup('db.sql')),
    P('zip-backup', '/backup.zip', 'advanced', zipBackup('backup.zip')),
    P('zip-site', '/site.zip', 'advanced', zipBackup('site.zip')),
    P('zip-www', '/www.zip', 'advanced', zipBackup('www.zip')),
    P('private-key', '/id_rsa', 'advanced', {
      ...EXPOSURE,
      severity: 'high',
      title: 'A private key file is publicly readable',
      test: (r) => (ok200(r) && /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(r.text) ? 'The file begins with a private-key header (contents not shown or kept).' : null),
      why: 'A private key proves identity to servers. Anyone with it can impersonate the owner.',
      impact: 'Server access or the ability to impersonate the site, depending on what the key protects.',
      fix: 'Remove the file, treat the key as compromised and replace it everywhere it was trusted.',
      verify: 'Confirm only the first line. Never download or store the key.',
    }),
    P('laravel-ignition', '/_ignition/health-check', 'advanced', {
      category: 'A05',
      theme: 'exposure',
      severity: 'high',
      title: 'Laravel Ignition debug endpoint is reachable',
      test: (r) => (ok200(r) && /can_execute_commands/.test(r.text) ? 'The response contains "can_execute_commands" from Ignition.' : null),
      why: 'Ignition is a development error page. Older versions had a remote-code-execution flaw (CVE-2021-3129) and it should not be reachable in production.',
      impact: 'Debug mode is on. Depending on the version this can allow code execution.',
      fix: 'Set APP_DEBUG=false in production, remove facade/ignition from production dependencies and update Laravel.',
      verify: 'Confirm the response only. Do not send any requests to other Ignition endpoints.',
    }),
    P('laravel-telescope', '/telescope', 'advanced', {
      category: 'A05',
      theme: 'exposure',
      severity: 'medium',
      title: 'Laravel Telescope is reachable',
      test: (r) => (ok200(r) && /Laravel Telescope/i.test(r.text) ? 'The page is Laravel Telescope.' : null),
      why: 'Telescope records requests, queries and exceptions, including data users submitted.',
      impact: 'Exposes application internals and potentially user data.',
      fix: 'Restrict Telescope with its gate or disable it in production.',
      verify: 'Confirm the page title only.',
    }),
    P('tomcat-manager', '/manager/html', 'advanced', {
      category: 'A05',
      theme: 'admin',
      severity: 'low',
      title: 'Tomcat Manager prompts for login from the internet',
      test: (r) => (r && r.status === 401 && /tomcat/i.test(String(r.wwwAuthenticate || '')) ? 'The path answers with an authentication challenge for Tomcat Manager.' : null),
      why: 'Tomcat Manager lets administrators deploy code. It is often attacked with default credentials.',
      impact: 'Default or weak credentials could allow remote code execution.',
      fix: 'Restrict it to an admin network or remove it from production.',
      verify: 'Do not try credentials. Confirm with the owner that it is expected.',
    }),
    P('swagger-ui', '/swagger-ui.html', 'advanced', {
      category: 'A05',
      theme: 'exposure',
      severity: 'info',
      title: 'Swagger UI is public',
      test: (r) => (ok200(r) && /Swagger UI/i.test(r.text) ? 'The page is Swagger UI.' : null),
      why: 'Interactive API documentation lists every endpoint and lets visitors call them.',
      impact: 'Makes it easier to find unprotected endpoints.',
      fix: 'Require authentication for API docs in production or remove them.',
      verify: 'Open the page and review which endpoints are listed.',
    }),
    P('debug-log', '/debug.log', 'advanced', logProbe('debug.log')),
    P('error-log', '/error.log', 'advanced', logProbe('error.log')),
    P('laravel-log', '/storage/logs/laravel.log', 'advanced', logProbe('storage/logs/laravel.log')),
    P('dir-files', '/files/', 'advanced', dirProbe('Files', 'medium')),
    P('dir-tmp', '/tmp/', 'advanced', dirProbe('Temporary files', 'medium')),
    P('dir-assets', '/assets/', 'advanced', dirProbe('Assets', 'low')),
    P('dir-images', '/images/', 'advanced', dirProbe('Images', 'low')),
    P('dir-static', '/static/', 'advanced', dirProbe('Static files', 'low')),
    P('dir-media', '/media/', 'advanced', dirProbe('Media', 'low')),
    P('dir-git', '/.git/', 'advanced', dirProbe('.git', 'high')),
  ];

  function dirProbe(label, severity) {
    return {
      category: 'A05',
      theme: 'exposure',
      severity,
      title: label + ' directory listing is enabled',
      test: (r) => (ok200(r) && /<title>Index of \/|<h1>Index of \/|Directory listing for \//i.test(r.text) ? 'The server returns an automatic file listing ("Index of /…").' : null),
      why: 'Directory listing shows every file in a folder, including ones that were never meant to be found.',
      impact: 'Exposes file names and sometimes the files themselves (backups, exports, uploads).',
      fix: 'Disable automatic directory listings in the web server and add an index file or deny access.',
      example: 'nginx:  autoindex off;\nApache: Options -Indexes',
      verify: 'Open the folder address and check whether a file list appears.',
    };
  }
  function envVariant(file) {
    return {
      ...EXPOSURE,
      severity: 'high',
      title: file + ' is publicly readable',
      test: (r) => {
        if (!ok200(r) || looksHtml(r)) return null;
        const vars = names(r.text, /^([A-Z][A-Z0-9_]{2,})\s*=/gm);
        return vars.length ? vars.length + ' variable name(s) such as ' + vars.slice(0, 5).join(', ') + '. Values are not shown or kept.' : null;
      },
      why: 'Environment files normally hold credentials and signing secrets.',
      impact: 'Anyone who can read it may gain access to databases or third-party services.',
      fix: 'Remove it from the web root, deny dot-files and rotate every value it contained.',
      verify: 'Check the response in a private window and look only at the variable names.',
    };
  }
  function configBackup(file) {
    return {
      ...EXPOSURE,
      severity: 'high',
      title: 'Configuration backup ' + file + ' is readable as text',
      test: (r) => (ok200(r) && /DB_PASSWORD|DB_NAME|define\(\s*['"]AUTH_KEY/.test(r.text) ? 'The file contains application configuration constants (values not shown or kept).' : null),
      why: 'A backup copy of a configuration file is served as plain text instead of being executed, so its credentials become readable.',
      impact: 'Database credentials and secret keys can be read by anyone.',
      fix: 'Delete backup copies from the web root and rotate the credentials.',
      verify: 'Check the first lines of the response only. Never copy values.',
    };
  }
  function sqlBackup(file) {
    return {
      ...EXPOSURE,
      severity: 'high',
      title: 'Database dump ' + file + ' is publicly readable',
      test: (r) => (ok200(r) && !looksHtml(r) && /(CREATE TABLE|INSERT INTO|DROP TABLE IF EXISTS)/i.test(r.text) ? 'The response contains SQL statements (contents not shown or kept).' : null),
      why: 'A SQL dump holds the whole database, which usually includes user accounts and personal data.',
      impact: 'Mass exposure of user and business data.',
      fix: 'Delete the dump from the web root, check access logs for downloads and treat the data as breached if it was fetched.',
      verify: 'Confirm only that the response is SQL. Do not download the file.',
    };
  }
  function zipBackup(file) {
    return {
      ...EXPOSURE,
      severity: 'high',
      title: 'Archive ' + file + ' is publicly downloadable',
      test: (r) => (ok200(r) && r.text.startsWith('PK') ? 'The response begins with the ZIP signature "PK". Only the first bytes were read.' : null),
      why: 'Archives of a site or backup often contain source code, configuration and data.',
      impact: 'Source code and secrets may be exposed.',
      fix: 'Delete the archive from the web root and check logs to see whether it was downloaded.',
      verify: 'Do not download the archive. The ZIP signature in the first bytes is enough evidence.',
    };
  }
  function logProbe(file) {
    return {
      category: 'A09',
      theme: 'exposure',
      severity: 'medium',
      title: 'Log file ' + file + ' is publicly readable',
      test: (r) =>
        ok200(r) && !looksHtml(r) && /(\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|Stack trace|Traceback|Exception|ERROR)/.test(r.text.slice(0, 4000))
          ? 'The response looks like application log output (contents not shown or kept).'
          : null,
      why: 'Logs often contain stack traces, internal paths, user identifiers and sometimes tokens.',
      impact: 'Leaks internals that help an attacker and may expose user data.',
      fix: 'Keep logs outside the web root and deny access to *.log files.',
      verify: 'Check the first lines only; do not copy the contents.',
    };
  }

  const probesFor = (tier) => PROBES.filter((p) => tier === 'advanced' || p.tier === 'standard');

  // Runs one probe against a response. Returns the evidence string, or null.
  function runProbe(probe, res, ctx) {
    if (!res || res.redirected) return null;
    try {
      return probe.test(res, ctx || {}) || null;
    } catch (_) {
      return null;
    }
  }

  /* ---------- secrets in scripts and pages ---------- */

  const mask = (v) => (v.length <= 8 ? '…(' + v.length + ' chars)' : v.slice(0, 4) + '…(' + v.length + ' chars)');
  const PLACEHOLDER = /(x{4,}|\*{4,}|your[_-]?|example|changeme|placeholder|dummy|process\.env|<[^>]+>|\$\{)/i;

  function entropy(s) {
    const freq = {};
    for (const c of s) freq[c] = (freq[c] || 0) + 1;
    let e = 0;
    for (const k in freq) {
      const p = freq[k] / s.length;
      e -= p * Math.log2(p);
    }
    return e;
  }

  function jwtClaims(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = typeof atob === 'function' ? atob(part) : Buffer.from(part, 'base64').toString('utf8');
      const claims = JSON.parse(json);
      return claims && typeof claims === 'object' ? claims : null;
    } catch (_) {
      return null;
    }
  }

  /*
   * Each rule describes a kind of credential. `severity` is the impact if the value is live; the
   * finding's status is always "potential" because DevForge never tries a credential to find out.
   */
  const SECRET_RULES = [
    { id: 'aws-access-key', label: 'AWS access key ID', re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, severity: 'high', confidence: 'medium', note: 'An access key ID alone is not enough to use an account, but it is usually stored next to a secret key.' },
    { id: 'private-key-block', label: 'private key block', re: /(-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----)/g, severity: 'high', confidence: 'high' },
    { id: 'stripe-secret', label: 'Stripe live secret key', re: /\b(sk_live_[0-9a-zA-Z]{20,})\b/g, severity: 'high', confidence: 'high' },
    { id: 'github-token', label: 'GitHub token', re: /\b(gh[pousr]_[A-Za-z0-9]{36,})\b/g, severity: 'high', confidence: 'high' },
    { id: 'slack-token', label: 'Slack token', re: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, severity: 'high', confidence: 'high' },
    { id: 'sendgrid-key', label: 'SendGrid API key', re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g, severity: 'high', confidence: 'high' },
    { id: 'google-api-key', label: 'Google API key', re: /\b(AIza[0-9A-Za-z_-]{35})\b/g, severity: 'low', confidence: 'medium', note: 'Google API keys are often meant to be public in browser code. What matters is whether the key is restricted to your domains and APIs.' },
    { id: 'jwt', label: 'JSON Web Token', re: /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, severity: 'medium', confidence: 'low', note: 'Tokens embedded in page code are sometimes deliberate public tokens (for example an anonymous client token). The claims decide the risk.' },
    {
      id: 'generic-secret',
      label: 'hard-coded credential-like value',
      // Every repetition is bounded: an unbounded prefix and suffix made matching quadratic, so a
      // script made of repeated keywords could freeze the panel (80 KB took about 2 s).
      re: /\b([A-Za-z0-9_$.-]{0,40}(?:api[_-]?key|secret|token|passwd|password)[A-Za-z0-9_$.-]{0,40})\s{0,4}[:=]\s{0,4}['"]([A-Za-z0-9_\-/+=]{16,200})['"]/gi,
      group: 2,
      nameGroup: 1,
      severity: 'medium',
      confidence: 'low',
      accept: (v) => !PLACEHOLDER.test(v) && entropy(v) >= 3.2,
    },
  ];

  /*
   * Finds credential-like values in `text`. Returns hits with the value masked; the raw value is
   * never part of the result. `where` is a label such as a script path (no query string).
   */
  function scanSecrets(text, where) {
    const hits = [];
    const seen = new Set();
    const body = String(text || '').slice(0, 1500000);
    for (const rule of SECRET_RULES) {
      for (const m of body.matchAll(rule.re)) {
        const value = m[rule.group || 1];
        if (rule.accept && !rule.accept(value)) continue;
        let severity = rule.severity;
        let note = rule.note || '';
        let claims = null;
        if (rule.id === 'jwt') {
          claims = jwtClaims(value);
          if (claims && /service_role|admin/i.test(String(claims.role || ''))) {
            severity = 'high';
            note = 'The token claims a privileged role (' + String(claims.role).slice(0, 20) + '). Privileged tokens must never be in browser code.';
          } else if (claims && claims.exp && claims.exp * 1000 < Date.now()) {
            severity = 'low';
            note = 'The token has already expired.';
          }
        }
        const key = rule.id + ':' + mask(value);
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          type: rule.id,
          label: rule.label,
          severity,
          confidence: rule.confidence,
          masked: mask(value),
          name: rule.nameGroup ? m[rule.nameGroup].slice(0, 60) : undefined,
          where,
          note,
          claims: claims ? Object.keys(claims).slice(0, 8) : undefined,
        });
        if (hits.length >= 50) return hits;
      }
    }
    return hits;
  }

  /* ---------- libraries ---------- */

  const parseVer = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
  function cmp(a, b) {
    const x = parseVer(a);
    const y = parseVer(b);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  }

  /* Advisories are an offline, hand-maintained list: they are hints to check, not a vulnerability
     scanner. Each entry says which versions it covers and what the advisory is. */
  const LIBRARIES = [
    {
      name: 'jQuery',
      re: /jquery[-.@/]v?(\d+\.\d+\.\d+)(?:\.min)?/i,
      advisories: [
        { below: '3.5.0', severity: 'medium', text: 'Cross-site scripting through HTML passed to jQuery methods (CVE-2020-11022, CVE-2020-11023), fixed in 3.5.0.' },
        { below: '3.4.0', severity: 'medium', text: 'Prototype pollution in $.extend (CVE-2019-11358), fixed in 3.4.0.' },
      ],
    },
    {
      name: 'Bootstrap',
      re: /bootstrap[-.@/]v?(\d+\.\d+\.\d+)(?:\.min)?/i,
      advisories: [
        { match: (v) => cmp(v, '3.0.0') >= 0 && cmp(v, '3.4.1') < 0, severity: 'medium', text: 'Cross-site scripting in tooltip/popover data attributes (CVE-2019-8331 and earlier), fixed in 3.4.1.' },
        { match: (v) => cmp(v, '4.0.0') >= 0 && cmp(v, '4.3.1') < 0, severity: 'medium', text: 'Cross-site scripting in tooltip/popover data attributes (CVE-2019-8331), fixed in 4.3.1.' },
        { match: (v) => cmp(v, '3.0.0') < 0, severity: 'medium', text: 'Bootstrap 2 and older are unmaintained and have known cross-site scripting issues.' },
      ],
    },
    {
      name: 'AngularJS',
      re: /angular(?:\.?js)?[-.@/]v?(1\.\d+\.\d+)(?:\.min)?/i,
      advisories: [{ below: '99.0.0', severity: 'medium', text: 'AngularJS 1.x reached end of life in December 2021 and no longer gets security fixes.' }],
    },
    {
      name: 'Lodash',
      re: /lodash(?:\.js)?[-.@/]v?(\d+\.\d+\.\d+)(?:\.min)?/i,
      advisories: [
        { below: '4.17.21', severity: 'medium', text: 'Command injection in _.template (CVE-2021-23337) and prototype pollution (CVE-2020-8203, fixed in 4.17.19), fixed in 4.17.21.' },
      ],
    },
    {
      name: 'Moment.js',
      re: /moment(?:\.js)?[-.@/]v?(\d+\.\d+\.\d+)(?:\.min)?/i,
      advisories: [{ below: '2.29.4', severity: 'low', text: 'Path traversal (CVE-2022-24785) and a regular-expression denial of service (CVE-2022-31129), fixed in 2.29.4.' }],
    },
  ];

  // Hosts whose scripts carry a documented supply-chain risk. Keep this list short and sourced.
  const RISKY_HOSTS = [
    {
      host: /(^|\.)polyfill\.io$/i,
      severity: 'high',
      text: 'polyfill.io was acquired in 2024 and served malicious JavaScript to sites that embedded it. Remove it; browsers no longer need most of its polyfills, and Cloudflare and Fastly run trusted mirrors.',
    },
  ];

  /* Returns libraries whose version, read from the file name or path, matches an advisory. */
  function detectLibraries(urls) {
    const found = [];
    const seen = new Set();
    for (const raw of urls || []) {
      const path = String(raw).split(/[?#]/)[0];
      for (const lib of LIBRARIES) {
        const m = path.match(lib.re);
        if (!m) continue;
        const version = m[1];
        const hits = lib.advisories.filter((a) => (a.below ? cmp(version, a.below) < 0 : a.match(version)));
        if (!hits.length) continue;
        const key = lib.name + version;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({
          name: lib.name,
          version,
          url: path,
          severity: hits.some((a) => a.severity === 'medium') ? 'medium' : hits[0].severity,
          advisories: hits.map((a) => a.text),
        });
      }
    }
    return found;
  }

  function riskyHosts(urls) {
    const out = [];
    const seen = new Set();
    for (const raw of urls || []) {
      let host;
      try {
        host = new URL(raw).hostname;
      } catch (_) {
        continue;
      }
      for (const r of RISKY_HOSTS) {
        if (r.host.test(host) && !seen.has(host)) {
          seen.add(host);
          out.push({ host, severity: r.severity, text: r.text });
        }
      }
    }
    return out;
  }

  /* ---------- text detectors ---------- */

  // Server-side error output and debug banners that should not reach visitors.
  const ERROR_PATTERNS = [
    { id: 'python-traceback', re: /Traceback \(most recent call last\)/, label: 'a Python traceback' },
    { id: 'java-stack', re: /\bat (?:[a-z_$][\w$]*\.)+[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.java:\d+\)/, label: 'a Java stack trace' },
    { id: 'php-error', re: /(?:Fatal error|Parse error|Warning|Notice):\s.{0,200}\sin\s\S+\.php\son line\s\d+/, label: 'a PHP error with a file path' },
    { id: 'dotnet-stack', re: /Server Error in '\/[^']*' Application|System\.(?:NullReference|InvalidOperation)Exception/, label: 'an ASP.NET error page' },
    { id: 'sql-error', re: /(SQLSTATE\[\w+\]|You have an error in your SQL syntax|ORA-\d{5}|PG::\w+Error|SQLite3?::\w+Exception|Unclosed quotation mark)/, label: 'a database error message' },
    { id: 'django-debug', re: /You're seeing this error because you have <code>DEBUG = True|DEBUG = True/, label: 'the Django debug page' },
    { id: 'laravel-whoops', re: /Whoops! There was an error|Illuminate\\[A-Za-z\\]+Exception/, label: 'a Laravel error page' },
    { id: 'rails-error', re: /Action Controller: Exception caught|ActionView::Template::Error/, label: 'a Rails error page' },
    // Bounded to one line: `[^)]+` used to run to the end of the text and backtrack (quadratic).
    { id: 'node-stack', re: /\n[ \t]+at (?:Object\.|Module\.|async )?[\w.<>$]{1,100} \((?:\/|[A-Z]:\\)[^)\n]{1,300}:\d+:\d+\)/, label: 'a Node.js stack trace' },
    { id: 'apache-banner', re: /Apache\/\d+\.\d+(?:\.\d+)?[^<]{0,40}Server at /, label: 'an Apache error footer with a version' },
  ];
  function findErrorLeaks(text) {
    const body = String(text || '').slice(0, 200000);
    return ERROR_PATTERNS.filter((p) => p.re.test(body)).map((p) => ({ id: p.id, label: p.label }));
  }

  const directoryListing = (text) =>
    /<title>Index of \/|<h1>Index of \/|Directory listing for \//i.test(String(text || '').slice(0, 4000));

  // robots.txt is public by design, but Disallow lines can point at things worth a second look.
  const INTERESTING = /(admin|backup|bak|private|secret|internal|staging|dev|test|config|db|dump|login|upload|api\/v?\d|\.git|\.env|phpmyadmin)/i;
  function parseRobots(text) {
    const disallow = [];
    const sitemaps = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = line.match(/^\s*(Disallow|Sitemap)\s*:\s*(\S+)/i);
      if (!m) continue;
      if (/^disallow$/i.test(m[1])) disallow.push(m[2]);
      else sitemaps.push(m[2]);
    }
    return { disallow: disallow.slice(0, 200), sitemaps: sitemaps.slice(0, 20), interesting: disallow.filter((p) => INTERESTING.test(p)).slice(0, 15) };
  }

  const sourceMapRef = (text) => {
    const m = String(text || '').slice(-4000).match(/[#@]\s*sourceMappingURL=([^\s'"*]+)/);
    return m ? m[1] : null;
  };

  return {
    PROBES,
    probesFor,
    runProbe,
    isSafeProbePath,
    fingerprint,
    baselineOf,
    sameAsBaseline,
    scanSecrets,
    jwtClaims,
    detectLibraries,
    riskyHosts,
    findErrorLeaks,
    directoryListing,
    parseRobots,
    sourceMapRef,
    cmpVersion: cmp,
  };
})();
if (typeof module !== 'undefined') module.exports = DFSecProbe;
