"use client"

import * as React from "react"
import { Link, useLocation } from 'react-router-dom'
import {
  Settings2,
  LayoutDashboard,
  Building2,
  Clock,
  MonitorCog
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { UserMenu } from "@/components/UserMenu"




export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {

  const location = useLocation()
  // On a phone the sidebar is a sheet over the page; picking a page should put it away.
  const { setOpenMobile } = useSidebar()

  const navItems = [
    {
      title: "Dashboard",
      url: "/",
      icon: LayoutDashboard,
      isActive: location.pathname === "/",
    },
    {
      title: "Campuses",
      url: "/campuses",
      icon: Building2,
      isActive: location.pathname === "/campuses",
    },
    {
      title: "Incidents",
      url: "/incidents",
      icon: Clock,
      isActive: location.pathname === "/incidents",
    },
    {
      title: "Settings",
      url: "/settings",
      icon: Settings2,
      isActive: location.pathname === "/settings",
    },
  ]

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
       <SidebarHeader>
        {/* The site's name: the page's banner landmark (the header inside main is the page's own). */}
        <header>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              {/* The district's mark goes home, as a site's name does; it is the one link outside the Pages list. */}
              <Link to="/" aria-label="Celina ISD Temperature Monitor, home" onClick={() => setOpenMobile(false)}>
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <MonitorCog className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">Celina ISD</span>
                  <span className="truncate text-xs">Temperature Monitor</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        </header>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="Pages">
        <SidebarMenu>
      {navItems.map((item) => (
        <SidebarMenuItem key={item.title}>
          <SidebarMenuButton asChild isActive={item.isActive}>
            <Link to={item.url} aria-current={item.isActive ? 'page' : undefined} onClick={() => setOpenMobile(false)}>
              <item.icon />
              <span>{item.title}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
        </nav>
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
        {/* Plain text, not a button: there is nothing here to press. A footer, so it sits in a landmark. */}
        <footer className="truncate px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {new Date().getFullYear()} ©
        </footer>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}