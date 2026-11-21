// Refreshes the profile README (Featured + Stack sections) and the streak cards in assets/.
// Called from .github/workflows/update-featured.yml through actions/github-script.

const fs = require("fs");
const path = require("path");

const FEATURED_COUNT = 4;
const STACK_COUNT = 10;
const STACK_SAMPLE = 20; // most recently pushed public repos used for the Stack section

// Always shown in Stack, even when no public repo uses them (the iOS work lives in private repos).
const PINNED_LANGUAGES = ["Swift"];
// Build/config files that aren't really "stack".
const IGNORED_LANGUAGES = new Set(["Dockerfile", "Makefile", "Batchfile", "Procfile"]);

// GitHub language name -> [badge color, simple-icons slug or null]
const LANGUAGES = {
  JavaScript: ["F7DF1E", "javascript"],
  TypeScript: ["3178C6", "typescript"],
  Python: ["3776AB", "python"],
  Kotlin: ["7F52FF", "kotlin"],
  Swift: ["F05138", "swift"],
  HTML: ["E34F26", "html5"],
  CSS: ["663399", "css"],
  SCSS: ["CC6699", "sass"],
  Shell: ["4EAA25", "gnubash"],
  PowerShell: ["5391FE", null],
  Astro: ["BC52EE", "astro"],
  "C++": ["00599C", "cplusplus"],
  C: ["A8B9CC", "c"],
  "C#": ["512BD4", "dotnet"],
  Java: ["B07219", "openjdk"],
  Go: ["00ADD8", "go"],
  Rust: ["B7410E", "rust"],
  Dart: ["0175C2", "dart"],
  Vue: ["4FC08D", "vuedotjs"],
  Svelte: ["FF3E00", "svelte"],
  Ruby: ["CC342D", "ruby"],
  PHP: ["777BB4", "php"],
  MDX: ["1B1F24", "mdx"],
  Lua: ["000080", "lua"],
  "Jupyter Notebook": ["F37626", "jupyter"],
  Solidity: ["363636", "solidity"],
  "Objective-C": ["438EFF", null],
};

const STREAK_THEMES = {
  dark: { accent: "#FFFFFF", text: "#888888", date: "#6E7681", line: "#30363D" },
  light: { accent: "#1F2328", text: "#656D76", date: "#8C959F", line: "#D0D7DE" },
};

module.exports = async ({ github, context, core, root = process.cwd() }) => {
  const owner = context.repo.owner;
  const readmePath = path.join(root, "README.md");
  const readme = fs.readFileSync(readmePath, "utf8");

  const FEATURED = /<!-- featured:start -->[\s\S]*?<!-- featured:end -->/;
  const STACK = /<!-- stack:start -->[\s\S]*?<!-- stack:end -->/;
  if (!FEATURED.test(readme) || !STACK.test(readme)) {
    core.setFailed("Profile README markers were not found.");
    return;
  }

  const repos = (
    await github.paginate(github.rest.repos.listForUser, {
      username: owner,
      type: "owner",
      per_page: 100,
    })
  ).filter(repo => !repo.fork && !repo.archived && repo.name !== context.repo.repo);

  const featured = featuredTable(repos, owner);
  const stack = `<!-- stack:start -->\n${await stackBadges(github, owner, repos)}\n<!-- stack:end -->`;
  // Function replacements so "$" in repo descriptions is never treated as a pattern.
  const updated = readme.replace(FEATURED, () => featured).replace(STACK, () => stack);

  if (updated === readme) core.info("README already up to date.");
  else fs.writeFileSync(readmePath, updated);

  try {
    const days = await contributionDays(github, owner);
    const stats = streakStats(days);
    fs.mkdirSync(path.join(root, "assets"), { recursive: true });
    for (const theme of Object.keys(STREAK_THEMES)) {
      fs.writeFileSync(path.join(root, "assets", `streak-${theme}.svg`), streakCard(stats, owner, theme));
    }
    core.info(`Streak: current ${stats.current.length}, longest ${stats.longest.length}, total ${stats.total}.`);
  } catch (error) {
    // Keep the previous cards rather than failing the whole refresh.
    core.warning(`Streak cards not refreshed: ${error.message}`);
  }
};

// ---------- Featured ----------

function featuredTable(repos, owner) {
  const top = [...repos]
    .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
    .slice(0, FEATURED_COUNT);
  const rows = top.map(
    repo =>
      `| ⭐&nbsp;${repo.stargazers_count.toLocaleString("en-US")} | **[${cell(repo.name)}](${repo.html_url})** | ${cell(repo.description || `A project by ${owner}`)} |`
  );
  return ["<!-- featured:start -->", "| | Repo | Description |", "|---|---|---|", ...rows, "<!-- featured:end -->"].join("\n");
}

function cell(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "|": "&#124;" };
  return String(value).replace(/[&<>"'|]/g, char => entities[char]).replace(/\s+/g, " ").trim();
}

// ---------- Stack ----------

async function stackBadges(github, owner, repos) {
  const recent = [...repos].sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at)).slice(0, STACK_SAMPLE);
  const responses = await Promise.all(recent.map(repo => github.rest.repos.listLanguages({ owner, repo: repo.name })));

  const bytes = {};
  for (const { data } of responses) {
    for (const [language, count] of Object.entries(data)) {
      if (!IGNORED_LANGUAGES.has(language)) bytes[language] = (bytes[language] || 0) + count;
    }
  }

  const ranked = Object.keys(bytes).sort((a, b) => bytes[b] - bytes[a]);
  const missingPins = PINNED_LANGUAGES.filter(language => !ranked.slice(0, STACK_COUNT).includes(language));
  const stack = [...ranked.filter(l => !missingPins.includes(l)).slice(0, STACK_COUNT - missingPins.length), ...missingPins];
  return stack.map(badge).join("\n");
}

function badge(language) {
  const [color, logo] = LANGUAGES[language] || ["64748B", null];
  const query = new URLSearchParams({ style: "flat" });
  if (logo) {
    query.set("logo", logo);
    query.set("logoColor", isLight(color) ? "black" : "white");
  }
  const label = encodeURIComponent(language.replace(/-/g, "--").replace(/_/g, "__"));
  return `![${language}](https://img.shields.io/badge/${label}-${color}?${query})`;
}

// Same brightness rule shields.io uses to pick dark text, so the logo matches the label.
function isLight(hex) {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 255000 >= 0.69;
}

// ---------- Streak ----------

async function contributionDays(github, login) {
  const { user } = await github.graphql(
    `query($login: String!) { user(login: $login) { contributionsCollection { contributionYears } } }`,
    { login }
  );
  const now = new Date();
  const counts = new Map();
  for (const year of user.contributionsCollection.contributionYears) {
    const from = new Date(Date.UTC(year, 0, 1));
    const to = new Date(Math.min(Date.UTC(year + 1, 0, 1) - 1000, now.getTime()));
    if (from > now) continue;
    const result = await github.graphql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      { login, from: from.toISOString(), to: to.toISOString() }
    );
    for (const week of result.user.contributionsCollection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        counts.set(day.date, Math.max(counts.get(day.date) || 0, day.contributionCount));
      }
    }
  }
  return { counts, today: now.toISOString().slice(0, 10) };
}

function streakStats({ counts, today }) {
  const dates = [...counts.keys()].filter(date => date <= today).sort();
  const active = dates.filter(date => counts.get(date) > 0);
  const total = active.reduce((sum, date) => sum + counts.get(date), 0);

  let longest = { length: 0, start: today, end: today };
  let run = null;
  for (const date of active) {
    run = run && addDays(run.end, 1) === date ? { ...run, length: run.length + 1, end: date } : { length: 1, start: date, end: date };
    if (run.length > longest.length) longest = run;
  }

  // Today doesn't break the streak until it's over.
  let cursor = counts.get(today) > 0 ? today : addDays(today, -1);
  const end = cursor;
  let length = 0;
  while (counts.get(cursor) > 0) {
    length++;
    cursor = addDays(cursor, -1);
  }
  const current = length ? { length, start: addDays(cursor, 1), end } : { length: 0, start: today, end: today };

  return { total, first: active[0] || today, current, longest, today };
}

function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function formatDate(date, withYear) {
  const options = { month: "short", day: "numeric", timeZone: "UTC" };
  if (withYear) options.year = "numeric";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", options);
}

function formatRange({ start, end }, today) {
  const thisYear = today.slice(0, 4);
  const withYear = start.slice(0, 4) !== thisYear || end.slice(0, 4) !== thisYear;
  if (start === end) return formatDate(start, withYear);
  return `${formatDate(start, withYear)} – ${formatDate(end, withYear)}`;
}

function streakCard(stats, login, themeName) {
  const t = STREAK_THEMES[themeName];
  const n = value => value.toLocaleString("en-US");
  const days = value => `${value === 1 ? "day" : "days"}`;
  const font = `'Segoe UI', Ubuntu, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif`;
  const totalRange = `${formatDate(stats.first, true)} – Present`;
  const currentRange = formatRange(stats.current, stats.today);
  const longestRange = formatRange(stats.longest, stats.today);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img" aria-labelledby="title desc">
  <title id="title">GitHub contribution streak for ${login}</title>
  <desc id="desc">${n(stats.total)} total contributions. Current streak: ${n(stats.current.length)} ${days(stats.current.length)}. Longest streak: ${n(stats.longest.length)} ${days(stats.longest.length)}.</desc>
  <style>
    text { font-family: ${font}; text-anchor: middle; }
    .num { font-size: 28px; font-weight: 700; fill: ${t.text}; }
    .label { font-size: 14px; font-weight: 400; fill: ${t.text}; }
    .label-main { font-size: 14px; font-weight: 700; fill: ${t.accent}; }
    .date { font-size: 12px; fill: ${t.date}; }
  </style>
  <defs>
    <mask id="ring-gap">
      <rect width="495" height="195" fill="#FFFFFF"/>
      <circle cx="247.5" cy="31" r="13" fill="#000000"/>
    </mask>
  </defs>
  <line x1="165" y1="28" x2="165" y2="170" stroke="${t.line}" stroke-width="1"/>
  <line x1="330" y1="28" x2="330" y2="170" stroke="${t.line}" stroke-width="1"/>

  <text class="num" x="82.5" y="79">${n(stats.total)}</text>
  <text class="label" x="82.5" y="114">Total Contributions</text>
  <text class="date" x="82.5" y="145">${totalRange}</text>

  <circle cx="247.5" cy="71" r="40" fill="none" stroke="${t.accent}" stroke-width="5" mask="url(#ring-gap)"/>
  <path transform="translate(235.5 18) scale(1)" fill="${t.accent}" d="M12 1.5c1.2 3.8 5.5 6.5 6.6 10.9 1.2 4.8-2 10.1-6.6 10.1s-7.6-3.9-6.8-8.3c.5-2.6 2.1-4.3 3.2-5.6.2 2 1.1 3.4 2.5 4-.6-3.8.4-8 1.1-11.1z"/>
  <text class="num" x="247.5" y="82" style="fill: ${t.accent}">${n(stats.current.length)}</text>
  <text class="label-main" x="247.5" y="140">Current Streak</text>
  <text class="date" x="247.5" y="166">${currentRange}</text>

  <text class="num" x="412.5" y="79">${n(stats.longest.length)}</text>
  <text class="label" x="412.5" y="114">Longest Streak</text>
  <text class="date" x="412.5" y="145">${longestRange}</text>
</svg>
`;
}

module.exports._internal = { badge, isLight, streakStats, streakCard, featuredTable, cell, addDays };
