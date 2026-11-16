/**
 * 文本读取保险：剥离 UTF-8 BOM（Windows 记事本/PowerShell 5 产物常见——1.4 §6.2/§6.3
 * 的 YAML 文件由人类维护，必须容忍）。
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
