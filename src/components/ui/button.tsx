import { Button as ArcButton, type ButtonProps } from "../arc/button/button";
// Keep Looproom's shared control names while Arc owns rendering and interaction.
type Props = Omit<ButtonProps, "variant" | "size"> & {
  variant?:
    | "default"
    | "destructive"
    | "outline"
    | "secondary"
    | "ghost"
    | "link";
  size?:
    | "default"
    | "xs"
    | "sm"
    | "lg"
    | "icon"
    | "icon-xs"
    | "icon-sm"
    | "icon-lg";
};
export function Button({
  variant = "default",
  size = "default",
  ...props
}: Props) {
  const arcVariant =
    variant === "default"
      ? "primary"
      : variant === "destructive"
        ? "danger"
        : variant === "outline"
          ? "secondary"
          : variant === "link"
            ? "ghost"
            : variant;
  return (
    <ArcButton
      data-slot="button"
      data-variant={variant}
      data-size={size}
      variant={arcVariant}
      size={
        size === "lg" || size === "icon-lg"
          ? "lg"
          : size === "default" || size === "icon"
            ? "md"
            : "sm"
      }
      {...props}
    />
  );
}
