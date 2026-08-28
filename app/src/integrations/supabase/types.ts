export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      memory_entities: {
        Row: {
          entity_type: string;
          entity_value: string;
          first_seen: string;
          id: string;
          last_seen: string;
        };
        Insert: {
          entity_type: string;
          entity_value: string;
          first_seen?: string;
          id?: string;
          last_seen?: string;
        };
        Update: {
          entity_type?: string;
          entity_value?: string;
          first_seen?: string;
          id?: string;
          last_seen?: string;
        };
        Relationships: [];
      };
      memory_entity_edges: {
        Row: {
          created_at: string;
          id: string;
          relationship: string;
          source_entity_id: string;
          source_run_id: string;
          target_entity_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          relationship: string;
          source_entity_id: string;
          source_run_id: string;
          target_entity_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          relationship?: string;
          source_entity_id?: string;
          source_run_id?: string;
          target_entity_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "memory_entity_edges_source_entity_id_fkey";
            columns: ["source_entity_id"];
            isOneToOne: false;
            referencedRelation: "memory_entities";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "memory_entity_edges_source_run_id_fkey";
            columns: ["source_run_id"];
            isOneToOne: false;
            referencedRelation: "memory_runs";
            referencedColumns: ["run_id"];
          },
          {
            foreignKeyName: "memory_entity_edges_target_entity_id_fkey";
            columns: ["target_entity_id"];
            isOneToOne: false;
            referencedRelation: "memory_entities";
            referencedColumns: ["id"];
          },
        ];
      };
      memory_runs: {
        Row: {
          agent_tier_metrics: Json;
          causal_graph: Json;
          created_at: string;
          estimate_report: Json;
          id: string;
          memos: Json;
          run_id: string;
          task_description: string;
          task_embedding: string;
        };
        Insert: {
          agent_tier_metrics?: Json;
          causal_graph?: Json;
          created_at?: string;
          estimate_report?: Json;
          id?: string;
          memos?: Json;
          run_id: string;
          task_description: string;
          task_embedding: string;
        };
        Update: {
          agent_tier_metrics?: Json;
          causal_graph?: Json;
          created_at?: string;
          estimate_report?: Json;
          id?: string;
          memos?: Json;
          run_id?: string;
          task_description?: string;
          task_embedding?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      get_entity_neighborhood: {
        Args: { p_entity_type: string; p_entity_value: string };
        Returns: {
          created_at: string;
          relationship: string;
          run_id: string;
          source_type: string;
          source_value: string;
          target_type: string;
          target_value: string;
        }[];
      };
      search_similar_runs: {
        Args: {
          decay_lambda?: number;
          match_count?: number;
          query_embedding: string;
        };
        Returns: {
          causal_graph: Json;
          created_at: string;
          estimate_report: Json;
          memos: Json;
          run_id: string;
          similarity: number;
          task_description: string;
          temporal_weight: number;
          weighted_score: number;
        }[];
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
