# GitHub Homestead

Type a GitHub username and see their year as a hand-doodled village:

- **One home per repo** along a winding serpentine road. Windows are lit if the
  repo was pushed in the last ~3 months, dim if touched this year, dark if
  asleep. Roofs are scribbled in the repo's primary language color; starred
  repos get a star on the roof; forks render as flat-roofed sheds; repos
  pushed this week have smoke rising from the chimney.
- **Street lamps = contributions.** Twelve lamps line the road in month order.
  The brighter the lamp, the busier the month — hover one for the exact count.
- **Street vitality panel.** Active days, momentum, public PR merge rate, and
  how many homes still have their lights on.

## Run it

No build, no dependencies. Serve the folder with any static server:

```bash
python3 -m http.server 8000
# or: npx serve
```

Then open http://localhost:8000. Deploys anywhere static files go —
GitHub Pages, Cloudflare Pages, Netlify.

## How it works

Everything runs in the visitor's browser:

- `api.github.com` for the profile, repos, and PR search (CORS-enabled by
  GitHub; each visitor spends their own 60 req/hour unauthenticated quota —
  a lookup costs 3).
- [github-contributions-api](https://github.com/grubersjoe/github-contributions-api)
  for the contribution calendar (the raw GitHub page has no CORS headers). If
  it's unreachable, the street just renders unlit.
- [rough.js](https://roughjs.com) from a CDN draws the sketchy shapes;
  wobbles are seeded from repo names so the same profile always doodles the
  same way.
- Results are cached in localStorage for 10 minutes.

All displayed data is public GitHub data. Never add a GitHub token to this
app — client-side code is public, and GitHub revokes exposed tokens.

Not affiliated with GitHub.
