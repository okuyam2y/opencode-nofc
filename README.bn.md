# OpenCode (nofc fork)

**নেটিভ ফাংশন কলিং সমর্থন নেই এমন প্রোভাইডারদের জন্য টুল কলিং।**

[anomalyco/opencode](https://github.com/anomalyco/opencode)-এর ফর্ক — [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) মিডলওয়্যার সংহত করে যাতে স্ট্রাকচার্ড `tools` API প্যারামিটারের পরিবর্তে টেক্সট-ভিত্তিক প্রোটোকল (Hermes, XML) দিয়ে টুল কাজ করে।

## ইনস্টল

```bash
npx opencode-ai-nofc

# অথবা গ্লোবালি ইনস্টল করুন
npm i -g opencode-ai-nofc

# অথবা প্রি-বিল্ট বাইনারি ডাউনলোড করুন
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# অথবা সোর্স থেকে বিল্ড করুন
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## কেন এই ফর্ক?

অনেক API গেটওয়ে এবং সেলফ-হোস্টেড ইনফারেন্স সার্ভার (vLLM, LiteLLM, কাস্টম প্রক্সি) OpenAI-সামঞ্জস্যপূর্ণ রিকোয়েস্ট থেকে `tools` প্যারামিটার সরিয়ে দেয় বা উপেক্ষা করে। নেটিভ ফাংশন কলিং ছাড়া, OpenCode-এর টুলগুলো — read, write, bash এবং অন্যান্য — কাজ করে না।

এই ফর্ক মডেলের টেক্সট আউটপুট থেকে সরাসরি টুল কল পার্স করে সমস্যাটি সমাধান করে। মডেল প্লেইন টেক্সটে `<tool_call>` ট্যাগ লেখে, এবং পার্সার মিডলওয়্যার সেগুলোকে স্ট্যান্ডার্ড AI SDK টুল-কল ইভেন্টে রূপান্তর করে।

## কনফিগারেশন

`opencode.json`-এ আপনার প্রোভাইডার অপশনে `toolParser` যোগ করুন:

```jsonc
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://your-gateway/v1",
        "toolParser": "hermes-strict"
      },
      "models": {
        "your-model": {
          "name": "Your Model",
          "limit": { "context": 200000, "output": 32768 }
        }
      }
    }
  }
}
```

| মোড | বিবরণ |
|------|-------|
| `hermes-strict` | **প্রস্তাবিত।** সিস্টেম প্রম্পটে স্পষ্ট নিয়মসহ কঠোর JSON ফরম্যাট। সবচেয়ে নির্ভরযোগ্য। |
| `hermes` | স্ট্যান্ডার্ড Hermes প্রোটোকল। hermes-strict সমস্যা করলে ফলব্যাক। |
| `xml` | XML টুল কলিং-এ প্রশিক্ষিত মডেলের জন্য বিশুদ্ধ XML ফরম্যাট। |

## কী অন্তর্ভুক্ত

টুল পার্সারের বাইরে, এই ফর্ক যোগ করে:

- **স্ট্রিমিং ট্যাগ ফিল্টার** — দৃশ্যমান আউটপুটে লিক হওয়া `<tool_call>` / `<tool_response>` ট্যাগ সরায়
- **টুল কল ডিডুপ্লিকেশন** — একই LLM স্টেপের মধ্যে ডুপ্লিকেট টুল এক্সিকিউশন বাদ দেয়
- **`apply_patch` → `edit`/`write` স্বয়ংক্রিয় প্রতিস্থাপন** — টুল পার্সার সক্রিয় থাকলে diff-ভিত্তিক এডিটিং-কে লাইন-ভিত্তিক টুলে প্রতিস্থাপন করে
- **PDF / DOCX / XLSX টেক্সট এক্সট্রাকশন** এবং macOS Vision OCR
- **ফিনিশ রিজন হ্যান্ডলিং** — `unknown` ফিনিশ রিজনকে টার্মিনাল স্টেটে রূপান্তর করে, লুপ গার্ডরেইলসহ

**[সেটআপ গাইড →](docs/guides/toolparser-setup.md)** — মডেল-ভিত্তিক সেটিংস, মডেল সামঞ্জস্যতা তালিকা, এবং সমস্যা সমাধান।

## আপস্ট্রিমের সাথে সম্পর্ক

এই ফর্ক আপস্ট্রিম `dev` ব্রাঞ্চ ট্র্যাক করে এবং নিয়মিত রিবেস করা হয়। বাগ ফিক্স প্রযোজ্য হলে PR হিসেবে জমা দেওয়া হয়।

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (অফিসিয়াল `opencode-ai` প্যাকেজ থেকে আলাদা)
- সম্পর্কিত: [#2917](https://github.com/anomalyco/opencode/issues/2917) (কাস্টম টুল পার্সার অনুরোধ) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- লাইসেন্স: [MIT](LICENSE) (আপস্ট্রিমের মতো একই)

---

> *নিচে OpenCode-এর মূল README অনুসরণ করে।*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">ওপেন সোর্স এআই কোডিং এজেন্ট।</p>
<p align="center">
  <a href="https://opencode.ai/discord"><img alt="Discord" src="https://img.shields.io/discord/1391832426048651334?style=flat-square&label=discord" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="npm" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square" /></a>
  <a href="https://github.com/anomalyco/opencode/actions/workflows/publish.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/anomalyco/opencode/publish.yml?style=flat-square&branch=dev" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

### ইনস্টলেশন (Installation)

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> ইনস্টল করার আগে ০.১.x এর চেয়ে পুরোনো ভার্সনগুলো মুছে ফেলুন।

### ডেস্কটপ অ্যাপ (BETA)

OpenCode ডেস্কটপ অ্যাপ্লিকেশন হিসেবেও উপলব্ধ। সরাসরি [রিলিজ পেজ](https://github.com/anomalyco/opencode/releases) অথবা [opencode.ai/download](https://opencode.ai/download) থেকে ডাউনলোড করুন।

| প্ল্যাটফর্ম           | ডাউনলোড                               |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage           |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### ইনস্টলেশন ডিরেক্টরি (Installation Directory)

ইনস্টল স্ক্রিপ্টটি ইনস্টলেশন পাতের জন্য নিম্নলিখিত অগ্রাধিকার ক্রম মেনে চলে:

1. `$OPENCODE_INSTALL_DIR` - কাস্টম ইনস্টলেশন ডিরেক্টরি
2. `$XDG_BIN_DIR` - XDG বেস ডিরেক্টরি স্পেসিফিকেশন সমর্থিত পাথ
3. `$HOME/bin` - সাধারণ ব্যবহারকারী বাইনারি ডিরেক্টরি (যদি বিদ্যমান থাকে বা তৈরি করা যায়)
4. `$HOME/.opencode/bin` - ডিফল্ট ফলব্যাক

```bash
# উদাহরণ
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### এজেন্টস (Agents)

OpenCode এ দুটি বিল্ট-ইন এজেন্ট রয়েছে যা আপনি `Tab` কি(key) দিয়ে পরিবর্তন করতে পারবেন।

- **build** - ডিফল্ট, ডেভেলপমেন্টের কাজের জন্য সম্পূর্ণ অ্যাক্সেসযুক্ত এজেন্ট
- **plan** - বিশ্লেষণ এবং কোড এক্সপ্লোরেশনের জন্য রিড-ওনলি এজেন্ট
  - ডিফল্টভাবে ফাইল এডিট করতে দেয় না
  - ব্যাশ কমান্ড চালানোর আগে অনুমতি চায়
  - অপরিচিত কোডবেস এক্সপ্লোর করা বা পরিবর্তনের পরিকল্পনা করার জন্য আদর্শ

এছাড়াও জটিল অনুসন্ধান এবং মাল্টিস্টেপ টাস্কের জন্য একটি **general** সাবএজেন্ট অন্তর্ভুক্ত রয়েছে।
এটি অভ্যন্তরীণভাবে ব্যবহৃত হয় এবং মেসেজে `@general` লিখে ব্যবহার করা যেতে পারে।

এজেন্টদের সম্পর্কে আরও জানুন: [docs](https://opencode.ai/docs/agents)।

### ডকুমেন্টেশন (Documentation)

কিভাবে OpenCode কনফিগার করবেন সে সম্পর্কে আরও তথ্যের জন্য, [**আমাদের ডকস দেখুন**](https://opencode.ai/docs)।

### অবদান (Contributing)

আপনি যদি OpenCode এ অবদান রাখতে চান, অনুগ্রহ করে একটি পুল রিকোয়েস্ট সাবমিট করার আগে আমাদের [কন্ট্রিবিউটিং ডকস](./CONTRIBUTING.md) পড়ে নিন।

### OpenCode এর উপর বিল্ডিং (Building on OpenCode)

আপনি যদি এমন প্রজেক্টে কাজ করেন যা OpenCode এর সাথে সম্পর্কিত এবং প্রজেক্টের নামের অংশ হিসেবে "opencode" ব্যবহার করেন, উদাহরণস্বরূপ "opencode-dashboard" বা "opencode-mobile", তবে দয়া করে আপনার README তে একটি নোট যোগ করে স্পষ্ট করুন যে এই প্রজেক্টটি OpenCode দল দ্বারা তৈরি হয়নি এবং আমাদের সাথে এর কোনো সরাসরি সম্পর্ক নেই।

### সচরাচর জিজ্ঞাসিত প্রশ্নাবলী (FAQ)

#### এটি ক্লড কোড (Claude Code) থেকে কীভাবে আলাদা?

ক্যাপাবিলিটির দিক থেকে এটি ক্লড কোডের (Claude Code) মতই। এখানে মূল পার্থক্যগুলো দেওয়া হলো:

- ১০০% ওপেন সোর্স
- কোনো প্রোভাইডারের সাথে আবদ্ধ নয়। যদিও আমরা [OpenCode Zen](https://opencode.ai/zen) এর মাধ্যমে মডেলসমূহ ব্যবহারের পরামর্শ দিই, OpenCode ক্লড (Claude), ওপেনএআই (OpenAI), গুগল (Google), অথবা লোকাল মডেলগুলোর সাথেও ব্যবহার করা যেতে পারে। যেমন যেমন মডেলগুলো উন্নত হবে, তাদের মধ্যকার পার্থক্য কমে আসবে এবং দামও কমবে, তাই প্রোভাইডার-অজ্ঞাস্টিক হওয়া খুবই গুরুত্বপূর্ণ।
- আউট-অফ-দ্য-বক্স LSP সাপোর্ট
- TUI এর উপর ফোকাস। OpenCode নিওভিম (neovim) ব্যবহারকারী এবং [terminal.shop](https://terminal.shop) এর নির্মাতাদের দ্বারা তৈরি; আমরা টার্মিনালে কী কী সম্ভব তার সীমাবদ্ধতা ছাড়িয়ে যাওয়ার চেষ্টা করছি।
- ক্লায়েন্ট/সার্ভার আর্কিটেকচার। এটি যেমন OpenCode কে আপনার কম্পিউটারে চালানোর সুযোগ দেয়, তেমনি আপনি মোবাইল অ্যাপ থেকে রিমোটলি এটি নিয়ন্ত্রণ করতে পারবেন, অর্থাৎ TUI ফ্রন্টএন্ড কেবল সম্ভাব্য ক্লায়েন্টগুলোর মধ্যে একটি।

---

**আমাদের কমিউনিটিতে যুক্ত হোন** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
