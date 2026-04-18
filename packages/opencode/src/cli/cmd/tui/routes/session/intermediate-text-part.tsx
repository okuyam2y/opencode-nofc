import { createSignal, Show, Switch, Match } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import type { IntermediateTextPart } from "./intermediate-text-collapse"

export function IntermediateTextPart(props: {
  last: boolean
  part: IntermediateTextPart
  message: AssistantMessage
  conceal?: boolean
}) {
  const { theme, syntax } = useTheme()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)
  const trimmed = () => props.part.text.trim()

  return (
    <Show when={trimmed()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={1} flexShrink={0}>
        <Switch>
          <Match when={!expanded()}>
            <text
              fg={theme.textMuted}
              onMouseUp={() => {
                if (renderer.getSelection()?.getSelectedText()) return
                setExpanded(true)
              }}
            >
              ↳ intermediate output ({trimmed().length} chars · click to expand)
            </text>
          </Match>
          <Match when={expanded()}>
            <Switch>
              <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                <markdown
                  syntaxStyle={syntax()}
                  streaming={false}
                  content={trimmed()}
                  conceal={props.conceal}
                  fg={theme.textMuted}
                  bg={theme.background}
                />
              </Match>
              <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN}>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={false}
                  syntaxStyle={syntax()}
                  content={trimmed()}
                  conceal={props.conceal}
                  fg={theme.textMuted}
                />
              </Match>
            </Switch>
          </Match>
        </Switch>
      </box>
    </Show>
  )
}
