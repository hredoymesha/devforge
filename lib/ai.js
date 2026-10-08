// Builds the prompt text for an AI task. Nothing is sent from here; the user pastes it into the chat site.
const DFAI = (() => {
  const PROVIDERS = {
    claude: { name: 'Claude', url: 'https://claude.ai/new', param: 'q', max: 6000 },
    chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', param: 'q', max: 6000 },
    gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', param: null, max: 0 },
    copilot: { name: 'Copilot', url: 'https://copilot.microsoft.com/', param: null, max: 0 },
  };
  const ACTIONS = {
    analyze:
      'Analyze this component. Describe its structure, styling approach, responsive behaviour and any problems you see.',
    fix: 'Find and fix defects in this component (layout bugs, invalid markup, CSS conflicts, accessibility problems). Return the corrected code.',
    recreate:
      'Recreate this component as clean, maintainable code that renders identically. Use the computed styles as ground truth.',
    optimize:
      'Optimize this component for performance, file size and maintainability without changing its appearance.',
    explain: 'Explain how this component works, step by step, for a developer new to the codebase.',
    debug:
      'Debug the problem described under Task. Explain the root cause, then give a minimal fix.',
    convert:
      'Convert this component to the target technology named under Task, preserving appearance and behaviour.',
    document:
      'Write developer documentation for this component: purpose, structure, props/inputs if inferable, CSS hooks, accessibility notes.',
    improve:
      "Improve this component's design, accessibility and responsiveness. Explain each change.",
  };
  const trunc = (s, n) =>
    s && s.length > n
      ? s.slice(0, n) + '\n/* …truncated by DevForge (' + s.length + ' chars total) */'
      : s || '';

  function build(spec) {
    // spec: {action, task, provider, includes:{html,css,js,a11y,network,errors}, ctx:{...}, budget}
    const a = ACTIONS[spec.action];
    if (!a) throw new Error('Unknown action: ' + spec.action);
    const c = spec.ctx || {},
      inc = spec.includes || {};
    const budget = spec.budget || 24000;
    const parts = [];
    parts.push(
      `# Task: ${spec.action.toUpperCase()}\n${a}${spec.task ? '\n\nAdditional requirements from the user:\n' + spec.task : ''}`
    );
    parts.push(
      `# Source\nPage: ${c.title || ''}\nURL: ${c.url || ''}\nCaptured by DevForge on ${new Date().toISOString()}.\nProvenance: HTML/CSS are EXTRACTED from the live DOM and readable stylesheets. JavaScript relations are INFERRED. Backend behaviour is UNAVAILABLE.`
    );
    if (c.selector)
      parts.push(
        `# Selected element\nSelector: ${c.selector}\nFramework hints (inferred): ${(c.framework || []).join(', ') || 'none'}`
      );
    if (inc.html && c.html)
      parts.push('# HTML\n```html\n' + trunc(c.html, Math.floor(budget * 0.3)) + '\n```');
    if (inc.css && c.css)
      parts.push('# CSS\n```css\n' + trunc(c.css, Math.floor(budget * 0.35)) + '\n```');
    if (inc.js && c.js)
      parts.push(
        '# Related JavaScript (inferred by name matching)\n```js\n' +
          trunc(c.js, Math.floor(budget * 0.2)) +
          '\n```'
      );
    if (inc.a11y && c.a11y) parts.push('# Accessibility findings\n' + c.a11y);
    if (inc.errors && c.errors) parts.push('# Errors / console\n' + trunc(c.errors, 3000));
    if (inc.network && c.network)
      parts.push(
        '# Network (sensitive headers redacted)\n```json\n' + trunc(c.network, 4000) + '\n```'
      );
    if (c.limitations) parts.push('# Known limitations of the provided context\n' + c.limitations);
    parts.push(
      '# Output format\nReturn each file in its own fenced code block labelled with its language (```html, ```css, ```js). Do not omit code with comments like "rest unchanged". After the code, list assumptions and anything you could not determine.'
    );
    const text = parts.join('\n\n');
    return {
      text,
      chars: text.length,
      approxTokens: Math.ceil(text.length / 3.6),
      truncated: /truncated by DevForge/.test(text),
    };
  }

  function critique(original, reply) {
    return `# Task: CRITIQUE AND IMPROVE\nYou previously (or another assistant) produced the solution below for the original task. Act as a strict reviewer: find bugs, invalid code, missing cases, accessibility and security problems, then return an improved full version.\n\n## Original task\n${original}\n\n## Solution to review\n${reply}\n\n## Output\n1. A numbered list of concrete defects (or "none found" with reasons).\n2. The complete corrected code in fenced blocks.\n3. What you changed and why.`;
  }

  function launchPlan(provider, text) {
    const p = PROVIDERS[provider];
    if (!p) throw new Error('Unknown provider');
    const canPrefill = !!p.param && text.length <= p.max;
    return {
      name: p.name,
      url: canPrefill ? p.url + '?' + p.param + '=' + encodeURIComponent(text) : p.url,
      prefilled: canPrefill,
      clipboardNeeded: true,
      note: canPrefill
        ? 'Opened with the prompt in the URL (best effort - the site may ignore it) and copied to your clipboard as a fallback. Review the text before pressing send.'
        : 'Prompt copied to clipboard. Paste it into the chat yourself (too long for, or unsupported by, URL prefill).',
    };
  }
  return { PROVIDERS, ACTIONS, build, critique, launchPlan };
})();
if (typeof module !== 'undefined') module.exports = DFAI;
