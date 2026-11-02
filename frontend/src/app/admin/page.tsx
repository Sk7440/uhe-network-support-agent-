import type { Metadata } from "next";
import AdminDashboard from "@/components/admin";

export const metadata: Metadata = { title: "UHE IT Admin Console" };

export default function AdminPage() {
  return <AdminDashboard />;
}
