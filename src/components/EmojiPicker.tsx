import { useState } from 'react';

const EMOJIS = [
  '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊',
  '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😗',
  '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭',
  '🤔', '🤐', '😐', '😑', '😶', '😏', '😒', '🙄',
  '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷',
  '🤒', '🤕', '🤢', '🤮', '🥴', '😵', '🤯', '🤠',
  '🥳', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
  '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺',
  '👻', '👽', '🤖', '😺', '😸', '😹', '😻', '😼',
  '🙌', '👏', '👍', '👎', '👊', '✊', '🤛', '🤜',
  '🤞', '✌️', '🤟', '🤘', '👌', '❤️', '🧡', '💛',
  '💚', '💙', '💜', '🖤', '💔', '💕', '💞', '💗',
  '💖', '✨', '🔥', '⭐', '🎉', '🎊', '🎈', '💯',
];

const EMOJI_NAMES: Record<string, string> = {
  '😀': 'grinning happy smile',
  '😃': 'grinning big eyes happy smile',
  '😄': 'grinning eyes laugh happy smile',
  '😁': 'beaming teeth grin smile happy',
  '😅': 'sweat smile relief happy',
  '😂': 'joy tears laugh funny',
  '🤣': 'rolling floor laugh hilarious',
  '😊': 'smiling blush happy smile',
  '😇': 'innocent angel halo smile',
  '🙂': 'slight smile faint',
  '😉': 'wink flirt',
  '😌': 'relieved relaxed content',
  '😍': 'heart eyes love crush',
  '🥰': 'smiling hearts love adore',
  '😘': 'kiss blowing love',
  '😗': 'kissing puckered',
  '😋': 'yummy delicious tongue food',
  '😛': 'tongue silly playful',
  '😜': 'winking tongue silly',
  '🤪': 'crazy zany funny wild',
  '😝': 'squinting tongue funny',
  '🤑': 'money mouth rich greedy',
  '🤗': 'hug hands open',
  '🤭': 'hand over mouth secret shy',
  '🤔': 'thinking hmm ponder',
  '🤐': 'zipper mouth silence secret',
  '😐': 'neutral straight face',
  '😑': 'expressionless blank boring',
  '😶': 'silent no mouth mute',
  '😏': 'smirk smug sly',
  '😒': 'unamused annoyed eh',
  '🙄': 'eye roll annoyed sarcasm',
  '😬': 'grimace awkward nervous wince',
  '🤥': 'liar pinocchio nose lie',
  '😔': 'pensive sad thoughtful',
  '😪': 'sleepy tired yawning',
  '🤤': 'drooling hungry tasty',
  '😴': 'sleeping zzz night',
  '😷': 'mask sick cold flu',
  '🤒': 'thermometer sick fever ill',
  '🤕': 'bandage hurt injured',
  '🤢': 'nauseated sick vomit gross',
  '🤮': 'vomiting sick puke',
  '🥴': 'woozy dizzy drunk tipsy',
  '😵': 'dizzy head spin confused',
  '🤯': 'mind blown explosion shock',
  '🤠': 'cowboy hat western',
  '🥳': 'party hat celebrate birthday',
  '🥺': 'pleading puppy eyes begging',
  '😢': 'crying tear sad cry',
  '😭': 'sobbing crying loudly sad',
  '😤': 'triumph steam angry determined',
  '😠': 'angry mad furious',
  '😡': 'pouting rage furious red',
  '🤬': 'swearing cursing angry symbols',
  '😈': 'smiling devil evil mischievous',
  '👿': 'angry devil evil demon',
  '💀': 'skull death dead',
  '☠️': 'skull crossbones pirate danger',
  '💩': 'poop poop pile cute',
  '🤡': 'clown circus creepy',
  '👹': 'ogre monster demon',
  '👺': 'goblin monster angry',
  '👻': 'ghost spooky halloween',
  '👽': 'alien space ufo',
  '🤖': 'robot machine',
  '😺': 'grinning cat smile kitty',
  '😸': 'grinning cat smile kitty eyes',
  '😹': 'joy cat laugh tears',
  '😻': 'heart eyes cat love kitty',
  '😼': 'smirking cat kitty sly',
  '🙌': 'raising hands celebration praise',
  '👏': 'clap applause congrats',
  '👍': 'thumbs up like yes good',
  '👎': 'thumbs down dislike no',
  '👊': 'fist punch fistbump',
  '✊': 'raised fist power solidarity',
  '🤛': 'left fist fistbump',
  '🤜': 'right fist fistbump',
  '🤞': 'crossed fingers luck hope',
  '✌️': 'victory peace v two',
  '🤟': 'love you gesture rock',
  '🤘': 'rock on metal horns',
  '👌': 'ok perfect fine',
  '❤️': 'red heart love like',
  '🧡': 'orange heart love',
  '💛': 'yellow heart love',
  '💚': 'green heart love',
  '💙': 'blue heart love',
  '💜': 'purple heart love',
  '🖤': 'black heart love dark',
  '💔': 'broken heart heartbreak sad',
  '💕': 'two hearts love couple',
  '💞': 'revolving hearts love',
  '💗': 'growing heart love beating',
  '💖': 'sparkling heart love shine',
  '✨': 'sparkles shiny star magic',
  '🔥': 'fire hot lit burn',
  '⭐': 'star favorite rating',
  '🎉': 'party popper celebrate confetti',
  '🎊': 'confetti ball party celebrate',
  '🎈': 'balloon party birthday',
  '💯': 'hundred perfect full score',
};

interface EmojiPickerProps {
  onEmoji: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ onEmoji, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState('');
  const filtered = search
    ? EMOJIS.filter((e) => (EMOJI_NAMES[e] || '').includes(search.toLowerCase()))
    : EMOJIS;

  return (
    <div className="absolute bottom-20 left-4 right-4 max-h-64 bg-[#1C1C1E] border border-[#333] rounded-xl shadow-xl z-50 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#333]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search emoji..."
          className="flex-1 bg-[#0D0D0D] text-white text-sm rounded-lg px-3 py-1.5 outline-none border border-[#333]"
          autoFocus
        />
        <button onClick={onClose} className="text-[#666] hover:text-white text-sm">✕</button>
      </div>
      {filtered.length === 0 ? (
        <p className="text-xs text-[#555] text-center py-8">No emojis found</p>
      ) : (
        <div className="overflow-y-auto max-h-48 p-2 grid grid-cols-8 gap-1">
          {filtered.map((emoji) => (
            <button
              key={emoji}
              onClick={() => { onEmoji(emoji); onClose(); }}
              className="w-9 h-9 flex items-center justify-center text-lg hover:bg-[#333] rounded-lg transition-colors"
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
