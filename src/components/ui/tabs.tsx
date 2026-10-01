import * as Arc from "../arc/tabs/tabs";
import type { ComponentProps } from "react";
export const Tabs = Arc.Tabs;
export function TabsList({
  variant,
  ...props
}: ComponentProps<typeof Arc.TabsList> & { variant?: "default" | "line" }) {
  return <Arc.TabsList data-slot="tabs-list" {...props} />;
}
export function TabsTrigger(props: ComponentProps<typeof Arc.TabsTrigger>) {
  return <Arc.TabsTrigger data-slot="tabs-trigger" {...props} />;
}
export const TabsContent = Arc.TabsContent;
