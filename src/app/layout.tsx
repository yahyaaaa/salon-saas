import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Salon Suite",
    template: "%s · Salon Suite",
  },
  description:
    "Bookings, POS, loyalty, consent forms, payroll and reporting for salons and aesthetic clinics.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
