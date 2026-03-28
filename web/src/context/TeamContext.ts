import { createContext, useContext } from 'react'

type TeamContextType = { team: string }
export const TeamContext = createContext<TeamContextType>({ team: '' })
export const useTeam = () => useContext(TeamContext)
