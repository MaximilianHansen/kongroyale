# Contributing to Kong Royale

Thanks for wanting to help. This page covers how a change gets from your computer into the live game.

## How it works

1. **Fork** this repo and make your change on a branch in your fork.
2. **Open a pull request** against `main`. Tests run automatically; if you're not a collaborator, they start once a
   maintainer clicks **Approve and run**.
3. **The Committee of Truth and Prosperity reviews it.** That's the small group that runs Kong Royale; today it's Max
   Blade ([@MaximilianHansen](https://github.com/MaximilianHansen)). They may ask for changes. Nothing merges
   without their approval.
4. **It ships in the next drop.** A drop is a release of the live game at kongroyale.com. Each one is a GitHub
   Release whose notes credit everyone whose work is in it. Merging into `main` doesn't put a change live; a merged
   change usually ships in the next drop, but the Committee can hold one back.

Nobody can push to this repository directly, including the maintainers. Every change, from anyone, goes through a
reviewed pull request.

## Before you start

- **Small fixes** (a bug, a typo, a performance win): just open a pull request.
- **Bigger ideas** (new weapons, modes, map areas, balance changes, new dependencies, server changes): open an issue
  first and describe the idea. You'll find out whether it fits before you spend a weekend on it.

## Before you open the pull request

```sh
npm ci
npm run build
npm test
```

All checks must pass; the same ones run on your pull request. Then play your change: **Play** (a bot match in your
browser) or the **Firing Range** for most things, and `KR_EVENT_MODE=0 npm run server` plus an online room if you
touched multiplayer.

## What gets accepted

- **One thing per pull request.** It's much easier to review.
- **Show it working.** A screenshot or a short clip for anything you can see.
- **The server stays in charge.** Clients ask; the server decides hits, damage, loot and the storm.
- **Art, models, sound and fonts must be yours or clearly free to use** (CC0, or CC-BY with credit). Say where each
  one came from in the pull request. Nothing taken from other games, and no lookalikes of other games' characters
  or logos.
- **No file over 10 MB.** Every clone downloads the whole history, so a big file stays a cost even after it's
  deleted. Compress it, or ask in an issue first. CI checks this.
- **AI-assisted work is welcome.** Kong Royale was largely built with AI. You're responsible for every line: read
  it, run it, and be ready to explain it. Point your agent at [AGENTS.md](AGENTS.md).

By opening a pull request you agree that your contribution is released under this project's [MIT licence](LICENSE).

## Questions

Ask in [Discussions](https://github.com/MaximilianHansen/kongroyale/discussions).

## Reporting bugs

Open an issue with what you did, what happened, what you expected, and your browser and computer. A screenshot helps.

**Security problems and cheats are different:** report them privately, as described in [SECURITY.md](SECURITY.md).

## Be decent

Everyone here follows the [code of conduct](CODE_OF_CONDUCT.md).
