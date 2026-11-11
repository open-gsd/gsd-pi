/** The embedded host supplies its catalog; standalone GSD keeps devRoot discovery. */
export interface ProjectCatalogPreferences {
  projectSource?: "openclaw"
  devRoot?: string | null
}

export function projectCatalogRequest(preferences: ProjectCatalogPreferences): string | null {
  if (preferences.projectSource === "openclaw") return "/api/projects?detail=true"
  return preferences.devRoot ? `/api/projects?root=${encodeURIComponent(preferences.devRoot)}&detail=true` : null
}
