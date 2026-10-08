type StudyTheme='light'|'dark';
const THEME_KEY='zhixue:appearance:theme:v1';

/** Appearance is device-local and independent of personal learning caches. */
export function createStudyThemePreference(getStorage:()=>Pick<Storage,'getItem'|'setItem'>){
  let current:StudyTheme|undefined;
  const listeners=new Set<()=>void>();
  return {
    getSnapshot:():StudyTheme=>{
      if(current===undefined){
        try{current=getStorage().getItem(THEME_KEY)==='dark'?'dark':'light';}
        catch{current='light';}
      }
      return current;
    },
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    set:(theme:StudyTheme)=>{
      current=theme;
      try{getStorage().setItem(THEME_KEY,theme);}catch{/* In-page switching still works when browser storage is unavailable. */}
      for(const listener of listeners)listener();
    },
  };
}

export const studyThemePreference=createStudyThemePreference(()=>window.localStorage);
export const serverStudyTheme=():StudyTheme=>'light';
