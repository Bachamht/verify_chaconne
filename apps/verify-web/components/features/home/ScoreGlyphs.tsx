/** 示意图里会动的三种东西的形状，画面与顶栏图例共用（填色跟随使用处的 .ch-score-* 类） */

/** 提案：一个八分音符 */
export function NoteShape() {
  return (
    <>
      <ellipse cx="-2.5" cy="4.5" rx="6" ry="4.4" transform="rotate(-24 -2.5 4.5)" />
      <rect x="2.4" y="-14" width="1.7" height="18.5" rx="0.85" />
      <path d="M4.1 -14C8 -11.8 11.4 -8.8 9.4 -2.6C9.8 -6.2 7.6 -8.4 4.1 -9.2Z" />
    </>
  );
}

/** 买到的代币：六边形 */
export const TOKEN_D = "M0 -6.4L5.5 -3.2L5.5 3.2L0 6.4L-5.5 3.2L-5.5 -3.2Z";
