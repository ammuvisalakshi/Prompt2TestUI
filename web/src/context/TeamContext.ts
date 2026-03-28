import { createContext, useContext } from 'react'

type TeamContextType = { team: string; role: string }
export const TeamContext = createContext<TeamContextType>({ team: '', role: '' })
export const useTeam = () => useContext(TeamContext)
