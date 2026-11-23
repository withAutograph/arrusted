import type { ReactNode } from "react";
import "./styles.css";
export const metadata = { title: "Starter", description: "Shared tables and workflows" };
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
