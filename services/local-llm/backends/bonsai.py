from .mlx import MLXBackend
from typing import Generator, List, Dict, Any

class BonsaiBackend(MLXBackend):
    """
    1-bit Bonsaiモデルに最適化されたバックエンド。
    MLXBackendを継承しつつ、1-bit特有の初期化やパラメータ調整を行う。
    """
    
    def load_model(self, model_path: str):
        # 1-bitモデルのロードにはPrismMLのMLXフォークが必要である旨を表示
        if self.verbose:
            print(f"Loading 1-bit Bonsai model: {model_path}...")
        try:
            super().load_model(model_path)
            if self.verbose:
                print("Successfully loaded model using MLX kernels.")
        except Exception as e:
            print(f"Error: 1-bit Bonsai requires the PrismML MLX fork.")
            print("Please follow the setup instructions in implementation_plan.md")
            raise e

    def generate_stream(self, messages: List[Dict[str, str]], **kwargs) -> Generator[str, None, None]:
        # Bonsaiのコンテキストウィンドウ設定（8k = 8192）
        # 必要に応じて、ここでメッセージ履歴のトークン数計算と切り詰めを行うロジックなどを追加可能
        kwargs.setdefault("max_tokens", 1024) 
        kwargs.setdefault("temperature", 0.0)
        
        if self.verbose:
            print(f"[Bonsai] Using 8k context window limit.")
            
        return super().generate_stream(messages, **kwargs)
