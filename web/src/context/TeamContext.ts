import { createContext, useContext } from 'react'

type TeamContextType = { team: string; teamLoaded: boolean }
export const TeamContext = createContext<TeamContextType>({ team: '', teamLoaded: false })
export const useTeam = () => useContext(TeamContext)
