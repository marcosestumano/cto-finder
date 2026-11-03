// Monta o texto padrão dos alertas — usado no app (prévia) e no servidor (envio)
export const AVISO_STATUS  = ['PARADA', 'DANIFICADA', 'EM MANUTENÇÃO', 'NORMALIZADA']
export const AVISO_EQUIPES = ['CABISTA', 'REDE']

const clean = (v, max = 20) =>
  String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ').slice(0, max)

export function normalizarAviso(input = {}) {
  const tipo = input.tipo === 'primaria' ? 'primaria' : 'caixa'
  const status = AVISO_STATUS.includes(clean(input.status, 30)) ? clean(input.status, 30) : 'PARADA'
  const equipe = AVISO_EQUIPES.includes(clean(input.equipe)) ? clean(input.equipe) : ''
  return {
    tipo,
    area_cabo:  clean(input.area_cabo),
    sp:         tipo === 'caixa' ? clean(input.sp) : '',
    sec:        tipo === 'caixa' ? clean(input.sec) : '',
    cabo:       tipo === 'primaria' ? clean(input.cabo) : '',
    primaria:   tipo === 'primaria' ? clean(input.primaria) : '',
    status,
    equipe,
    observacao: String(input.observacao ?? '').trim().slice(0, 200),
  }
}

export function validarAviso(a) {
  if (a.tipo === 'caixa' && !a.area_cabo) return 'Informe a área da caixa'
  if (a.tipo === 'caixa' && !a.sp && !a.sec) return 'Informe SP ou SEC da caixa'
  if (a.tipo === 'primaria' && (!a.cabo || !a.primaria)) return 'Informe cabo e primária'
  return null
}

export function montarMensagem(a) {
  const equipe = a.equipe ? ` (${a.equipe})` : ''
  if (a.tipo === 'primaria') {
    const area = a.area_cabo ? `${a.area_cabo} ` : ''
    return `${area}CABO ${a.cabo || '__'} PRIMÁRIA ${a.primaria || '__'} ESTÁ ${a.status}${equipe}`
  }
  const partes = ['CAIXA', a.area_cabo || '__']
  if (a.sp)  partes.push(a.sp)
  if (a.sec) partes.push(`SEC ${a.sec}`)
  return `${partes.join(' ')} ESTÁ ${a.status}${equipe}`
}

export function tituloAviso(a) {
  return a.status === 'NORMALIZADA' ? 'NORMALIZADO' : 'ALERTA!'
}
