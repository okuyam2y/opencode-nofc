# OpenCode (nofc fork)

**네이티브 function calling을 지원하지 않는 프로바이더를 위한 도구 호출.**

[anomalyco/opencode](https://github.com/anomalyco/opencode)의 포크 — [`@ai-sdk-tool/parser`](https://www.npmjs.com/package/@ai-sdk-tool/parser) 미들웨어를 통합하여 구조화된 `tools` API 파라미터 대신 텍스트 기반 프로토콜(Hermes, XML)로 도구가 작동하도록 합니다.

## 설치

```bash
npx opencode-ai-nofc

# 또는 전역 설치
npm i -g opencode-ai-nofc

# 또는 사전 빌드된 바이너리 다운로드
curl -fsSL https://github.com/okuyam2y/opencode-nofc/releases/latest/download/opencode-$(uname -s | tr A-Z a-z)-$(uname -m).tar.gz | tar xz
./opencode

# 또는 소스에서 빌드
git clone https://github.com/okuyam2y/opencode-nofc.git
cd opencode-nofc && bun install && bun turbo build
```

## 왜 이 포크인가?

많은 API 게이트웨이와 셀프 호스팅 추론 서버(vLLM, LiteLLM, 커스텀 프록시)는 OpenAI 호환 요청에서 `tools` 파라미터를 제거하거나 무시합니다. 네이티브 function calling 없이는 OpenCode의 도구들 — read, write, bash 등 — 이 작동하지 않습니다.

이 포크는 모델의 텍스트 출력에서 직접 도구 호출을 파싱하여 문제를 해결합니다. 모델이 일반 텍스트로 `<tool_call>` 태그를 작성하면, 파서 미들웨어가 이를 표준 AI SDK 도구 호출 이벤트로 변환합니다.

## 설정

`opencode.json`의 프로바이더 옵션에 `toolParser`를 추가하세요:

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

| 모드 | 설명 |
|------|------|
| `hermes-strict` | **권장.** 시스템 프롬프트에 명시적 규칙이 포함된 엄격한 JSON 형식. 가장 안정적. |
| `hermes` | 표준 Hermes 프로토콜. hermes-strict에 문제가 있을 때 폴백. |
| `xml` | XML 도구 호출로 훈련된 모델을 위한 순수 XML 형식. |

## 포함된 기능

도구 파서 외에 이 포크는 다음을 추가합니다:

- **스트리밍 태그 필터** — 가시적 출력에 누출된 `<tool_call>` / `<tool_response>` 태그를 제거
- **도구 호출 중복 제거** — 동일 LLM 단계 내 중복 도구 실행을 삭제
- **`apply_patch` → `edit`/`write` 자동 전환** — 도구 파서 활성 시 diff 기반 편집을 라인 기반 도구로 대체
- **PDF / DOCX / XLSX 텍스트 추출** 및 macOS Vision OCR
- **종료 사유 처리** — `unknown` 종료 사유를 터미널 상태로 변환, 루프 가드레일 포함

**[설정 가이드 →](docs/guides/toolparser-setup.md)** — 모델별 설정, 모델 호환성 표, 문제 해결.

## 업스트림과의 관계

이 포크는 업스트림 `dev` 브랜치를 추적하며 정기적으로 리베이스합니다. 버그 수정은 해당되는 경우 PR로 제출합니다.

- npm: [`opencode-ai-nofc`](https://www.npmjs.com/package/opencode-ai-nofc) (공식 `opencode-ai` 패키지와 별도)
- 관련: [#2917](https://github.com/anomalyco/opencode/issues/2917) (커스텀 도구 파서 요청) · [#1122](https://github.com/anomalyco/opencode/issues/1122) (vLLM + Hermes)
- 라이선스: [MIT](LICENSE) (업스트림과 동일)

---

> *아래에 OpenCode 원본 README가 이어집니다.*

<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">오픈 소스 AI 코딩 에이전트.</p>
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

### 설치

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# 패키지 매니저
npm i -g opencode-ai@latest        # bun/pnpm/yarn 도 가능
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS 및 Linux (권장, 항상 최신)
brew install opencode              # macOS 및 Linux (공식 brew formula, 업데이트 빈도 낮음)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # 어떤 OS든
nix run nixpkgs#opencode           # 또는 github:anomalyco/opencode 로 최신 dev 브랜치
```

> [!TIP]
> 설치 전에 0.1.x 보다 오래된 버전을 제거하세요.

### 데스크톱 앱 (BETA)

OpenCode 는 데스크톱 앱으로도 제공됩니다. [releases page](https://github.com/anomalyco/opencode/releases) 에서 직접 다운로드하거나 [opencode.ai/download](https://opencode.ai/download) 를 이용하세요.

| 플랫폼                | 다운로드                              |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux                 | `.deb`, `.rpm`, 또는 AppImage         |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### 설치 디렉터리

설치 스크립트는 설치 경로를 다음 우선순위로 결정합니다.

1. `$OPENCODE_INSTALL_DIR` - 사용자 지정 설치 디렉터리
2. `$XDG_BIN_DIR` - XDG Base Directory Specification 준수 경로
3. `$HOME/bin` - 표준 사용자 바이너리 디렉터리 (존재하거나 생성 가능할 경우)
4. `$HOME/.opencode/bin` - 기본 폴백

```bash
# 예시
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode 에는 내장 에이전트 2개가 있으며 `Tab` 키로 전환할 수 있습니다.

- **build** - 기본값, 개발 작업을 위한 전체 권한 에이전트
- **plan** - 분석 및 코드 탐색을 위한 읽기 전용 에이전트
  - 기본적으로 파일 편집을 거부
  - bash 명령 실행 전에 권한을 요청
  - 낯선 코드베이스를 탐색하거나 변경을 계획할 때 적합

또한 복잡한 검색과 여러 단계 작업을 위한 **general** 서브 에이전트가 포함되어 있습니다.
내부적으로 사용되며, 메시지에서 `@general` 로 호출할 수 있습니다.

[agents](https://opencode.ai/docs/agents) 에 대해 더 알아보세요.

### 문서

OpenCode 설정에 대한 자세한 내용은 [**문서**](https://opencode.ai/docs) 를 참고하세요.

### 기여하기

OpenCode 에 기여하고 싶다면, Pull Request 를 제출하기 전에 [contributing docs](./CONTRIBUTING.md) 를 읽어주세요.

### OpenCode 기반으로 만들기

OpenCode 와 관련된 프로젝트를 진행하면서 이름에 "opencode"(예: "opencode-dashboard" 또는 "opencode-mobile") 를 포함한다면, README 에 해당 프로젝트가 OpenCode 팀이 만든 것이 아니며 어떤 방식으로도 우리와 제휴되어 있지 않다는 점을 명시해 주세요.

### FAQ

#### Claude Code 와는 무엇이 다른가요?

기능 면에서는 Claude Code 와 매우 유사합니다. 주요 차이점은 다음과 같습니다.

- 100% 오픈 소스
- 특정 제공자에 묶여 있지 않습니다. [OpenCode Zen](https://opencode.ai/zen) 을 통해 제공하는 모델을 권장하지만, OpenCode 는 Claude, OpenAI, Google 또는 로컬 모델과도 사용할 수 있습니다. 모델이 발전하면서 격차는 줄고 가격은 내려가므로 provider-agnostic 인 것이 중요합니다.
- 기본으로 제공되는 LSP 지원
- TUI 에 집중. OpenCode 는 neovim 사용자와 [terminal.shop](https://terminal.shop) 제작자가 만들었으며, 터미널에서 가능한 것의 한계를 밀어붙입니다.
- 클라이언트/서버 아키텍처. 예를 들어 OpenCode 를 내 컴퓨터에서 실행하면서 모바일 앱으로 원격 조작할 수 있습니다. 즉, TUI 프런트엔드는 가능한 여러 클라이언트 중 하나일 뿐입니다.

---

**커뮤니티에 참여하기** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
