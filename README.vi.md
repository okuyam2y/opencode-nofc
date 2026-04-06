# OpenCode (nofc fork)

**Gọi công cụ cho các nhà cung cấp không hỗ trợ function calling native.**

Fork của [anomalyco/opencode](https://github.com/anomalyco/opencode) — tích hợp middleware [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) để các công cụ hoạt động qua giao thức dựa trên văn bản (Hermes, XML) thay vì tham số `tools` API có cấu trúc.

## Cài đặt

```bash
npx opencode-ai-nofc

# hoặc cài đặt toàn cục
npm i -g opencode-ai-nofc

# hoặc tải xuống tệp nhị phân đã biên dịch
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# hoặc xây dựng từ mã nguồn
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## Tại sao fork này?

Nhiều API gateway và máy chủ suy luận tự host (vLLM, LiteLLM, proxy tùy chỉnh) loại bỏ hoặc bỏ qua tham số `tools` từ các yêu cầu tương thích OpenAI. Không có function calling native, các công cụ của OpenCode — read, write, bash và những công cụ khác — đơn giản không hoạt động.

Fork này giải quyết vấn đề bằng cách phân tích các cuộc gọi công cụ trực tiếp từ đầu ra văn bản của mô hình. Mô hình viết các thẻ `<tool_call>` bằng văn bản thuần, và middleware parser chuyển đổi chúng thành các sự kiện gọi công cụ AI SDK tiêu chuẩn.

## Cấu hình

Thêm `toolParser` vào tùy chọn nhà cung cấp trong `opencode.json`:

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

| Chế độ | Mô tả |
|--------|-------|
| `hermes-strict` | **Khuyến nghị.** Định dạng JSON nghiêm ngặt với các quy tắc rõ ràng trong system prompt. Đáng tin cậy nhất. |
| `hermes` | Giao thức Hermes tiêu chuẩn. Phương án dự phòng nếu hermes-strict gây vấn đề. |
| `xml` | Định dạng XML thuần cho các mô hình được huấn luyện với XML tool calling. |

## Những gì bao gồm

Ngoài tool parser, fork này thêm:

- **Bộ lọc thẻ streaming** — loại bỏ các thẻ `<tool_call>` / `<tool_response>` bị rò rỉ vào đầu ra hiển thị
- **Loại bỏ trùng lặp cuộc gọi công cụ** — loại bỏ các lần thực thi công cụ trùng lặp trong cùng bước LLM
- **Tự động thay thế `apply_patch` → `edit`/`write`** — thay thế chỉnh sửa dựa trên diff bằng các công cụ dựa trên dòng khi tool parser đang hoạt động
- **Trích xuất văn bản PDF / DOCX / XLSX** và macOS Vision OCR
- **Xử lý lý do kết thúc** — chuyển đổi lý do kết thúc `unknown` sang trạng thái cuối cùng, với bảo vệ chống vòng lặp

**[Hướng dẫn cài đặt →](docs/guides/toolparser-setup.md)** — cài đặt theo mô hình, bảng tương thích mô hình và khắc phục sự cố.

## Mối quan hệ với upstream

Fork này theo dõi nhánh `dev` của upstream và được rebase thường xuyên. Các bản sửa lỗi được gửi dưới dạng PR khi phù hợp.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (tách biệt với gói `opencode-ai` chính thức)
- Liên quan: [#2917](https://github.com/anomalyco/opencode/issues/2917) (yêu cầu tool parser tùy chỉnh) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- Giấy phép: [MIT](LICENSE) (giống với upstream)

---

> *README gốc của OpenCode tiếp theo bên dưới.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Trợ lý lập trình AI mã nguồn mở.</p>
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

### Cài đặt

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Các trình quản lý gói (Package managers)
npm i -g opencode-ai@latest        # hoặc bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS và Linux (khuyên dùng, luôn cập nhật)
brew install opencode              # macOS và Linux (công thức brew chính thức, ít cập nhật hơn)
sudo pacman -S opencode            # Arch Linux (Bản ổn định)
paru -S opencode-bin               # Arch Linux (Bản mới nhất từ AUR)
mise use -g opencode               # Mọi hệ điều hành
nix run nixpkgs#opencode           # hoặc github:anomalyco/opencode cho nhánh dev mới nhất
```

> [!TIP]
> Hãy xóa các phiên bản cũ hơn 0.1.x trước khi cài đặt.

### Ứng dụng Desktop (BETA)

OpenCode cũng có sẵn dưới dạng ứng dụng desktop. Tải trực tiếp từ [trang releases](https://github.com/anomalyco/opencode/releases) hoặc [opencode.ai/download](https://opencode.ai/download).

| Nền tảng              | Tải xuống                             |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, hoặc AppImage         |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Thư mục cài đặt

Tập lệnh cài đặt tuân theo thứ tự ưu tiên sau cho đường dẫn cài đặt:

1. `$OPENCODE_INSTALL_DIR` - Thư mục cài đặt tùy chỉnh
2. `$XDG_BIN_DIR` - Đường dẫn tuân thủ XDG Base Directory Specification
3. `$HOME/bin` - Thư mục nhị phân tiêu chuẩn của người dùng (nếu tồn tại hoặc có thể tạo)
4. `$HOME/.opencode/bin` - Mặc định dự phòng

```bash
# Ví dụ
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents (Đại diện)

OpenCode bao gồm hai agent được tích hợp sẵn mà bạn có thể chuyển đổi bằng phím `Tab`.

- **build** - Agent mặc định, có toàn quyền truy cập cho công việc lập trình
- **plan** - Agent chỉ đọc dùng để phân tích và khám phá mã nguồn
  - Mặc định từ chối việc chỉnh sửa tệp
  - Hỏi quyền trước khi chạy các lệnh bash
  - Lý tưởng để khám phá các codebase lạ hoặc lên kế hoạch thay đổi

Ngoài ra còn có một subagent **general** dùng cho các tìm kiếm phức tạp và tác vụ nhiều bước.
Agent này được sử dụng nội bộ và có thể gọi bằng cách dùng `@general` trong tin nhắn.

Tìm hiểu thêm về [agents](https://opencode.ai/docs/agents).

### Tài liệu

Để biết thêm thông tin về cách cấu hình OpenCode, [**hãy truy cập tài liệu của chúng tôi**](https://opencode.ai/docs).

### Đóng góp

Nếu bạn muốn đóng góp cho OpenCode, vui lòng đọc [tài liệu hướng dẫn đóng góp](./CONTRIBUTING.md) trước khi gửi pull request.

### Xây dựng trên nền tảng OpenCode

Nếu bạn đang làm việc trên một dự án liên quan đến OpenCode và sử dụng "opencode" như một phần của tên dự án, ví dụ "opencode-dashboard" hoặc "opencode-mobile", vui lòng thêm một ghi chú vào README của bạn để làm rõ rằng dự án đó không được xây dựng bởi đội ngũ OpenCode và không liên kết với chúng tôi dưới bất kỳ hình thức nào.

### Các câu hỏi thường gặp (FAQ)

#### OpenCode khác biệt thế nào so với Claude Code?

Về mặt tính năng, nó rất giống Claude Code. Dưới đây là những điểm khác biệt chính:

- 100% mã nguồn mở
- Không bị ràng buộc với bất kỳ nhà cung cấp nào. Mặc dù chúng tôi khuyên dùng các mô hình được cung cấp qua [OpenCode Zen](https://opencode.ai/zen), OpenCode có thể được sử dụng với Claude, OpenAI, Google, hoặc thậm chí các mô hình chạy cục bộ. Khi các mô hình phát triển, khoảng cách giữa chúng sẽ thu hẹp lại và giá cả sẽ giảm, vì vậy việc không phụ thuộc vào nhà cung cấp là rất quan trọng.
- Hỗ trợ LSP ngay từ đầu
- Tập trung vào TUI (Giao diện người dùng dòng lệnh). OpenCode được xây dựng bởi những người dùng neovim và đội ngũ tạo ra [terminal.shop](https://terminal.shop); chúng tôi sẽ đẩy giới hạn của những gì có thể làm được trên terminal lên mức tối đa.
- Kiến trúc client/server. Chẳng hạn, điều này cho phép OpenCode chạy trên máy tính của bạn trong khi bạn điều khiển nó từ xa qua một ứng dụng di động, nghĩa là frontend TUI chỉ là một trong những client có thể dùng.

---

**Tham gia cộng đồng của chúng tôi** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
