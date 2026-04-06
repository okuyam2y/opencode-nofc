# OpenCode (nofc fork)

**استدعاء الأدوات لمزودي الخدمات الذين لا يدعمون استدعاء الدوال الأصلي.**

فرع من [anomalyco/opencode](https://github.com/anomalyco/opencode) — يدمج وسيط [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) بحيث تعمل الأدوات من خلال بروتوكولات نصية (Hermes, XML) بدلاً من معامل `tools` API المهيكل.

## التثبيت

```bash
npx opencode-ai-nofc

# أو التثبيت العام
npm i -g opencode-ai-nofc

# أو تنزيل ملف ثنائي جاهز
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# أو البناء من المصدر
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## لماذا هذا الفرع؟

العديد من بوابات API وخوادم الاستدلال الذاتية الاستضافة (vLLM, LiteLLM, البروكسيات المخصصة) تزيل أو تتجاهل معامل `tools` من الطلبات المتوافقة مع OpenAI. بدون استدعاء الدوال الأصلي، لا تعمل أدوات OpenCode — read, write, bash وغيرها — ببساطة.

يحل هذا الفرع المشكلة عن طريق تحليل استدعاءات الأدوات مباشرة من مخرجات النموذج النصية. يكتب النموذج وسوم `<tool_call>` كنص عادي، ويحولها وسيط المحلل إلى أحداث استدعاء أدوات AI SDK القياسية.

## الإعداد

أضف `toolParser` إلى خيارات المزود في `opencode.json`:

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

| الوضع | الوصف |
|-------|-------|
| `hermes-strict` | **موصى به.** تنسيق JSON صارم مع قواعد صريحة في موجه النظام. الأكثر موثوقية. |
| `hermes` | بروتوكول Hermes القياسي. بديل احتياطي إذا تسبب hermes-strict في مشاكل. |
| `xml` | تنسيق XML خالص للنماذج المدربة على استدعاء الأدوات بـ XML. |

## ما يتضمنه

بالإضافة إلى محلل الأدوات، يضيف هذا الفرع:

- **مرشح وسوم البث** — يزيل وسوم `<tool_call>` / `<tool_response>` المتسربة إلى المخرجات المرئية
- **إزالة تكرار استدعاءات الأدوات** — يسقط تنفيذات الأدوات المكررة ضمن نفس خطوة LLM
- **الاستبدال التلقائي `apply_patch` → `edit`/`write`** — يستبدل التحرير القائم على الفروقات بأدوات قائمة على الأسطر عند تفعيل محلل الأدوات
- **استخراج نصوص PDF / DOCX / XLSX** و macOS Vision OCR
- **معالجة سبب الإنهاء** — يحول أسباب الإنهاء `unknown` إلى حالات نهائية، مع حواجز حماية من التكرار

**[دليل الإعداد →](docs/guides/toolparser-setup.md)** — إعدادات لكل نموذج، جدول توافق النماذج، واستكشاف الأخطاء.

## العلاقة مع المشروع الأصلي

يتتبع هذا الفرع فرع `dev` الأصلي ويتم إعادة تأسيسه بانتظام. يتم تقديم إصلاحات الأخطاء كطلبات سحب عند الاقتضاء.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (منفصل عن حزمة `opencode-ai` الرسمية)
- ذو صلة: [#2917](https://github.com/anomalyco/opencode/issues/2917) (طلب محلل أدوات مخصص) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- الترخيص: [MIT](LICENSE) (نفس المشروع الأصلي)

---

> *يلي أدناه ملف README الأصلي لـ OpenCode.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="شعار OpenCode">
    </picture>
  </a>
</p>
<p align="center">وكيل برمجة بالذكاء الاصطناعي مفتوح المصدر.</p>
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

### التثبيت

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# مديري الحزم
npm i -g opencode-ai@latest        # او bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS و Linux (موصى به، دائما محدث)
brew install opencode              # macOS و Linux (صيغة brew الرسمية، تحديث اقل)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # اي نظام
nix run nixpkgs#opencode           # او github:anomalyco/opencode لاحدث فرع dev
```

> [!TIP]
> احذف الاصدارات الاقدم من 0.1.x قبل التثبيت.

### تطبيق سطح المكتب (BETA)

يتوفر OpenCode ايضا كتطبيق سطح مكتب. قم بالتنزيل مباشرة من [صفحة الاصدارات](https://github.com/anomalyco/opencode/releases) او من [opencode.ai/download](https://opencode.ai/download).

| المنصة                | التنزيل                               |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb` او `.rpm` او AppImage          |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### مجلد التثبيت

يحترم سكربت التثبيت ترتيب الاولوية التالي لمسار التثبيت:

1. `$OPENCODE_INSTALL_DIR` - مجلد تثبيت مخصص
2. `$XDG_BIN_DIR` - مسار متوافق مع مواصفات XDG Base Directory
3. `$HOME/bin` - مجلد الثنائيات القياسي للمستخدم (ان وجد او امكن انشاؤه)
4. `$HOME/.opencode/bin` - المسار الافتراضي الاحتياطي

```bash
# امثلة
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

يتضمن OpenCode وكيليْن (Agents) مدمجين يمكنك التبديل بينهما باستخدام زر `Tab`.

- **build** - الافتراضي، وكيل بصلاحيات كاملة لاعمال التطوير
- **plan** - وكيل للقراءة فقط للتحليل واستكشاف الكود
  - يرفض تعديل الملفات افتراضيا
  - يطلب الاذن قبل تشغيل اوامر bash
  - مثالي لاستكشاف قواعد كود غير مألوفة او لتخطيط التغييرات

بالاضافة الى ذلك يوجد وكيل فرعي **general** للبحث المعقد والمهام متعددة الخطوات.
يستخدم داخليا ويمكن استدعاؤه بكتابة `@general` في الرسائل.

تعرف على المزيد حول [agents](https://opencode.ai/docs/agents).

### التوثيق

لمزيد من المعلومات حول كيفية ضبط OpenCode، [**راجع التوثيق**](https://opencode.ai/docs).

### المساهمة

اذا كنت مهتما بالمساهمة في OpenCode، يرجى قراءة [contributing docs](./CONTRIBUTING.md) قبل ارسال pull request.

### البناء فوق OpenCode

اذا كنت تعمل على مشروع مرتبط بـ OpenCode ويستخدم "opencode" كجزء من اسمه (مثل "opencode-dashboard" او "opencode-mobile")، يرجى اضافة ملاحظة في README توضح انه ليس مبنيا بواسطة فريق OpenCode ولا يرتبط بنا بأي شكل.

### FAQ

#### ما الفرق عن Claude Code؟

هو مشابه جدا لـ Claude Code من حيث القدرات. هذه هي الفروقات الاساسية:

- 100% مفتوح المصدر
- غير مقترن بمزود معين. نوصي بالنماذج التي نوفرها عبر [OpenCode Zen](https://opencode.ai/zen)؛ لكن يمكن استخدام OpenCode مع Claude او OpenAI او Google او حتى نماذج محلية. مع تطور النماذج ستتقلص الفجوات وستنخفض الاسعار، لذا من المهم ان يكون مستقلا عن المزود.
- دعم LSP جاهز للاستخدام
- تركيز على TUI. تم بناء OpenCode بواسطة مستخدمي neovim ومنشئي [terminal.shop](https://terminal.shop)؛ وسندفع حدود ما هو ممكن داخل الطرفية.
- معمارية عميل/خادم. على سبيل المثال، يمكن تشغيل OpenCode على جهازك بينما تقوده عن بعد من تطبيق جوال. هذا يعني ان واجهة TUI هي واحدة فقط من العملاء الممكنين.

---

**انضم الى مجتمعنا** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
